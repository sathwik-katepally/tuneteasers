#!/usr/bin/env node
/* Build public/corpus.json: the curated, film-songs-only pool the game draws
   from (docs/song-loading.md).

   Pipeline:
   1. Seed songs from JioSaavn's own editorial playlists (owner uid in config)
      found through playlist searches, plus the per-language charts.
   2. Verify each song is a Hindi/Telugu film song with the film's real year:
      the album name (cleaned) or a 'From "X"' clause must name a film in
      Wikidata for the song's language. Compilation copies are resolved to the
      original album copy through a title search (all copies of one song share
      one play count). Diacritics are folded and small spelling differences
      tolerated within the year window. Songs Saavn tags with a "starring"
      role are kept unverified when nothing marks them as a dub, a series or
      a single: no same-named Wikidata film of another language, no film of
      another language that year with the same cast, no same-named TV series.
   3. Score within language x decade: play-count percentile blended with
      editorial-playlist membership; tier cut-offs from the config.

   Run: node scripts/build-corpus.mjs   (CI: .github/workflows/refresh-corpus.yml)
   Env:
     CORPUS_OUT     output path override (default public/corpus.json)
     CORPUS_CACHE   directory to cache upstream responses for local reruns
     CORPUS_REPORT  path for a JSON report (rejections, per-song decisions) */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { songKey } from "../src/lib/utils.js";
import { EXCLUDE_RX } from "../src/lib/constants.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, "scripts/corpus.config.json"), "utf8"));
const OUT = process.env.CORPUS_OUT || path.join(REPO, "public/corpus.json");
const CACHE = process.env.CORPUS_CACHE || null;
const REPORT = process.env.CORPUS_REPORT || null;
const SAAVN = "https://www.jiosaavn.com/api.php?_format=json&_marker=0&api_version=4&ctx=web6dot0";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const WD_UA = "tuneteasers-corpus/1.0 (https://github.com/sathwik-katepally/tuneteasers)";
const LANGS = CFG.languages;
const LANG_NAMES = Object.keys({ ...LANGS, ...CFG.conflictLanguages });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const de = s => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* -- fetch with retry and an optional on-disk cache -- */
async function getText(url, headers, tries = 4){
  const key = CACHE && path.join(CACHE, crypto.createHash("sha1").update(url).digest("hex"));
  if (key && fs.existsSync(key)) return fs.readFileSync(key, "utf8");
  let last;
  for (let i = 0; i < tries; i++){
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: true });
      const t = await r.text();
      if (key){ fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(key, t); }
      return t;
    } catch (e){
      last = e;
      if (e.fatal) break;
      await sleep(1500 * (i + 1) ** 2);
    }
  }
  throw last;
}
const saavn = async q => {
  const t = await getText(SAAVN + q, { "user-agent": UA, accept: "application/json" });
  try { return JSON.parse(t); } catch { return null; }
};

/* -- Wikidata index: films by name (labels + aliases), by language x year
      (for fuzzy matching), cast member -> films, and TV series names -- */
const norm = s => de(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, "");
function parseCsv(text){
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"' && text[i + 1] === '"'){ field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ","){ row.push(field); field = ""; }
    else if (c === "\n" || c === "\r"){ if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}
async function sparql(query){
  const url = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query);
  return parseCsv(await getText(url, { accept: "text/csv", "user-agent": WD_UA })).slice(1);
}
async function loadFilms(){
  const byName = new Map(), byLangYear = new Map(), byActor = new Map(), series = new Set();
  const push = (map, k, v) => { if (!k) return; const l = map.get(k) || []; l.push(v); map.set(k, l); };
  const all = { ...Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [k, v.wikidata])), ...CFG.conflictLanguages };
  for (const [lang, qid] of Object.entries(all)){
    const films = await sparql(`SELECT ?f ?lab (MIN(YEAR(?d)) AS ?y) WHERE { ?f wdt:P31/wdt:P279* wd:Q11424; wdt:P364 wd:${qid}; wdt:P577 ?d. ?f rdfs:label ?lab FILTER(LANG(?lab)="en") } GROUP BY ?f ?lab`);
    const aliases = await sparql(`SELECT ?f ?alt WHERE { ?f wdt:P31/wdt:P279* wd:Q11424; wdt:P364 wd:${qid}; skos:altLabel ?alt FILTER(LANG(?alt)="en") }`);
    const cast = await sparql(`SELECT ?f ?al WHERE { ?f wdt:P31 wd:Q11424; wdt:P364 wd:${qid}; wdt:P161 ?a. ?a rdfs:label ?al FILTER(LANG(?al)="en") }`);
    const byId = new Map();
    for (const [f, lab, y] of films){
      const e = { y: parseInt(y), lang, label: lab, names: [norm(lab)], cast: new Set() };
      byId.set(f, e); push(byName, norm(lab), e); push(byLangYear, `${lang}/${e.y}`, e);
    }
    for (const [f, alt] of aliases){ const e = byId.get(f); if (!e) continue; const k = norm(alt); if (k && !e.names.includes(k)){ e.names.push(k); push(byName, k, e); } }
    for (const [f, al] of cast){ const e = byId.get(f); if (!e) continue; const k = norm(al); if (k && !e.cast.has(k)){ e.cast.add(k); push(byActor, k, e); } }
    console.log(`wikidata ${lang}: ${films.length} films, ${aliases.length} aliases, ${cast.length} cast credits`);
    await sleep(1000);
  }
  const langQids = Object.values(LANGS).map(v => `wd:${v.wikidata}`).join(" ");
  for (const [, lab] of await sparql(`SELECT ?s ?lab WHERE { VALUES ?lang { ${langQids} } ?s wdt:P31/wdt:P279* wd:Q5398426; wdt:P364 ?lang; rdfs:label ?lab FILTER(LANG(?lab)="en") }`)) series.add(norm(lab));
  console.log(`wikidata: ${series.size} hindi/telugu tv series`);
  return { byName, byLangYear, byActor, series };
}

/* Small spelling differences ("Badrenath" / "Badrinath", "Pournamy" /
   "Pournami") within the same language and year window; short names are
   never fuzzed ("Don" and "Dor" were both 2006 Hindi films). */
function levenshtein(a, b){
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++){
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++){
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
function fuzzyEq(a, b){
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 6) return false;
  const tol = Math.max(1, Math.floor(s.length / 8));
  if (l.length - s.length > tol) return s.length >= 8 && levenshtein(s, l.slice(0, s.length)) <= tol; // "Aravindha Sametha" vs "Aravinda Sametha Veera Raghava"
  return levenshtein(s, l) <= tol;
}

/* -- names: song titles and film names as Saavn writes them -- */
const LANG_RX = LANG_NAMES.join("|");
const FROM_RX = /[\(\[]\s*from\s+"([^"]+)"\s*[\)\]]|\s[-–—]\s*from\s+"([^"]+)"\s*$/i;
const DUB_RX = new RegExp(`\\(\\s*(${LANG_RX})\\s*\\)|\\[\\s*(${LANG_RX})\\s*\\]|\\s[-–—]\\s*(${LANG_RX})\\s*$|\\b(${LANG_RX})\\s+(version|dubbed)\\b|\\bdubbed\\b`, "i");
const OST_RX = /[\(\[]?\s*\b(original\s+(motion\s+picture\s+)?soundtrack|music\s+from\s+the\s+(motion\s+picture|film)|ost)\b\s*[\)\]]?/i;
const COMPILATION_RX = /\b(hits|best of|top \d|top\b|collection|jukebox|love songs|romantic|dance|party|playlist|special|essentials|classics|evergreen|forever|celebrat|superhit|blockbuster|chartbuster|melodies|mix|vol\.?|volume|anthems|songs|favourites|favorites|year|20\d\d|\d0s|retro|non.?stop|the best|greatest|ultimate|trending|viral|mashup|remix)\b/i;
const cleanTitle = s => de(s).replace(FROM_RX, "").replace(/\s+/g, " ").trim();
const fromClause = s => { const m = de(s).match(FROM_RX); return m ? (m[1] || m[2]).trim() : null; };
function cleanAlbum(album){
  let a = de(album);
  const from = fromClause(a);
  if (from) a = from;
  const dub = DUB_RX.test(a);
  a = a.replace(DUB_RX, " ").replace(OST_RX, " ").replace(/\s+/g, " ").replace(/[\s\-–—:]+$/, "").trim();
  return { name: a, dub };
}
/* Candidate film names for a song, most specific first. */
function filmCandidates(title, album){
  const out = [];
  const push = (n, dub) => { n = (n || "").trim(); if (n && !out.some(o => o.name === n)) out.push({ name: n, dub: !!dub }); };
  const fromTitle = fromClause(title);
  if (fromTitle) push(cleanAlbum(fromTitle).name, cleanAlbum(fromTitle).dub);
  const a = cleanAlbum(album);
  push(a.name, a.dub);
  const beforeDash = a.name.split(/\s[-–—:]\s/)[0];
  if (beforeDash !== a.name) push(beforeDash, a.dub);
  return out;
}

/* -- Saavn seed: editorial playlists + charts -- */
async function findPlaylists(){
  const pls = new Map();
  for (const lang of Object.keys(LANGS)){
    for (const q of CFG.playlistQueries[lang]) for (let p = 1; p <= CFG.playlistSearchPages; p++){
      const j = await saavn(`&__call=search.getPlaylistResults&q=${encodeURIComponent(q)}&n=20&p=${p}`);
      for (const r of j?.results || []){
        const mi = r.more_info || {};
        if (mi.uid !== CFG.playlistOwner) continue;
        if (!(mi.language in LANGS)) continue;
        pls.set(r.id, { id: r.id, title: de(r.title), lang: mi.language });
      }
      await sleep(150);
    }
    if (CFG.includeCharts){
      const j = await saavn(`&__call=content.getCharts&language=${lang}`);
      for (const c of Array.isArray(j) ? j : []) if (c.type === "playlist" && c.id) pls.set(c.id, { id: c.id, title: de(c.title), lang, chart: true });
    }
  }
  return [...pls.values()];
}
async function mapLimit(items, n, fn){
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length){ const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
async function harvest(playlists){
  const songs = new Map(); // saavn id -> { raw, pls:Set }
  let done = 0;
  await mapLimit(playlists, CFG.concurrency, async pl => {
    const j = await saavn(`&__call=playlist.getDetails&listid=${pl.id}&n=500&p=1`);
    for (const s of j?.list || []){
      if (s.type !== "song" || !(s.language in LANGS)) continue;
      const e = songs.get(s.id) || { raw: s, pls: new Set() };
      e.pls.add(pl.id);
      songs.set(s.id, e);
    }
    if (++done % 25 === 0) console.log(`  playlists ${done}/${playlists.length}, ${songs.size} songs`);
    await sleep(150);
  });
  return songs;
}

/* -- one song's verdict -- */
const roles = raw => (raw.more_info?.artistMap?.artists || []);
const names = (raw, role) => [...new Set(roles(raw).filter(a => a.role === role).map(a => de(a.name).trim()).filter(Boolean))];
const yearOf = raw => parseInt(raw.year) || 0;
const playsOf = raw => parseInt(raw.play_count) || 0;
const compilationAlbum = raw => COMPILATION_RX.test(cleanAlbum(raw.more_info?.album).name);

function makeMatcher(index){
  const tol = CFG.yearTolerance;
  const lookup = (name, lang) => (index.byName.get(norm(name)) || []).filter(f => f.lang === lang);
  const latest = hits => (hits.length ? hits.reduce((a, b) => (b.y > a.y ? b : a)) : null);
  return {
    /* film of this language released within +-tol of year, exact name first, then fuzzy */
    exact(name, lang, year){
      const hits = lookup(name, lang).filter(f => Math.abs(f.y - year) <= tol);
      if (hits.length) return latest(hits);
      const k = norm(name), fuzzy = new Set();
      for (let y = year - tol; y <= year + tol; y++)
        for (const f of index.byLangYear.get(`${lang}/${y}`) || []) if (f.names.some(n => fuzzyEq(k, n))) fuzzy.add(f);
      return fuzzy.size === 1 ? [...fuzzy][0] : null;
    },
    /* film of this language by name alone; the latest one not after the song copy */
    byName(name, lang, year){
      const hits = lookup(name, lang).filter(f => f.y <= year + tol);
      return hits.length ? hits.reduce((a, b) => (b.y > a.y ? b : a)) : null;
    },
    /* a film of another language this song could be a dub of: same name
       around this year, same name in any year with one of these actors, or
       a film of that year sharing the starring actors */
    conflict(name, lang, year, starring){
      const cast = new Set(starring.map(norm));
      const others = (index.byName.get(norm(name)) || []).filter(f => f.lang !== lang);
      if (others.some(f => Math.abs(f.y - year) <= tol)) return "dub-conflict";
      if (others.some(f => [...cast].some(a => f.cast.has(a)))) return "dub-cast";
      const overlap = new Map();
      for (const a of cast) for (const f of index.byActor.get(a) || []){
        if (f.lang === lang || Math.abs(f.y - year) > tol) continue;
        overlap.set(f, (overlap.get(f) || 0) + 1);
      }
      for (const [, n] of overlap) if (n >= Math.min(2, cast.size)) return "dub-cast";
      return null;
    },
    isSeries: name => index.series.has(norm(name)),
  };
}

function isFilmLike(name, title){
  if (!name || COMPILATION_RX.test(name)) return false;
  return norm(name) !== norm(cleanTitle(title));
}

async function siblings(raw){
  const title = cleanTitle(raw.title);
  const j = await saavn(`&__call=search.getResults&q=${encodeURIComponent(title)}&n=40&p=1`);
  const key = songKey(title), plays = playsOf(raw);
  const slack = Math.max(1000, plays * CFG.playCountTolerance);
  return (j?.results || []).filter(s => s.type === "song" && s.id !== raw.id && s.language === raw.language
    && songKey(cleanTitle(s.title)) === key && Math.abs(playsOf(s) - plays) <= slack)
    .sort((a, b) => yearOf(a) - yearOf(b));
}

async function classify(raw, M){
  const lang = raw.language, title = cleanTitle(raw.title), year = yearOf(raw);
  if (!title) return { reject: "no-title" };
  if (EXCLUDE_RX.test(de(raw.title))) return { reject: "excluded-title" };
  if (!playsOf(raw)) return { reject: "no-plays" };
  const copies = [raw];
  const verdict = (copy, film, f, yv) => ({ copy, film: f ? f.label : film, year: f ? f.y : year, yv, source: f ? "wikidata" : "starring" });

  const tryExact = copy => {
    for (const c of filmCandidates(copy.title, copy.more_info?.album)){
      if (c.dub) continue;
      const f = M.exact(c.name, lang, yearOf(copy));
      if (f) return verdict(copy, c.name, f, true);
    }
    return null;
  };
  let v = tryExact(raw);
  if (!v || compilationAlbum(raw)){
    // A compilation or re-release copy is resolved to a matching original album copy by shared play count.
    const sibs = await siblings(raw);
    copies.push(...sibs);
    const original = sibs.find(s => !compilationAlbum(s) && tryExact(s));
    if (original) v = tryExact(original);
    else if (compilationAlbum(raw)) return { reject: "no-original-copy" };
  }
  if (!v){
    // the name alone names a film of this language (a re-upload with a later year):
    // trust Wikidata's year, so a re-released pre-2000 song gets its real year and drops
    for (const copy of copies) for (const c of filmCandidates(copy.title, copy.more_info?.album)){
      if (!isFilmLike(c.name, title)) continue;
      const f = M.byName(c.name, lang, yearOf(copy));
      if (f){ v = verdict(copy, c.name, f, true); break; }
    }
  }
  if (!v){
    const starring = [...new Set(copies.flatMap(c => names(c, "starring")))];
    if (!starring.length) return { reject: "no-film" };
    // performers cast in their own video: a single, not a film
    const performers = new Set(copies.flatMap(c => ["singer", "music", "lyricist"].flatMap(r => names(c, r))).map(norm));
    if (starring.every(a => performers.has(norm(a)))) return { reject: "no-film" };
    for (const copy of copies){
      const c = filmCandidates(copy.title, copy.more_info?.album)[0];
      if (!c || !isFilmLike(c.name, title)) continue;
      if (c.dub) return { reject: "dub-marker" };
      if (M.isSeries(c.name)) return { reject: "series" };
      const minYear = Math.min(...copies.map(yearOf).filter(Boolean));
      const conflict = M.conflict(c.name, lang, minYear, starring);
      if (conflict) return { reject: conflict };
      v = verdict(copy, c.name, null, false); v.year = minYear;
      break;
    }
    if (!v) return { reject: "no-film" };
  }
  if (v.year < CFG.minYear) return { reject: "pre-" + CFG.minYear };
  if (playsOf(v.copy) < CFG.minPlays) return { reject: "low-plays" };
  return v;
}

/* -- scoring -- */
const decadeOf = y => `${Math.floor(y / 10) * 10}s`;
function percentiles(values){
  const sorted = [...values].sort((a, b) => a - b);
  return v => { let lo = 0, hi = sorted.length; while (lo < hi){ const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return sorted.length > 1 ? lo / (sorted.length - 1) : 1; };
}
function scoreAndTier(songs){
  const groups = new Map();
  for (const s of songs){ const k = `${s.language}/${decadeOf(s.year)}`; (groups.get(k) || groups.set(k, []).get(k)).push(s); }
  const { playsWeight, playlistsWeight } = CFG.score;
  for (const g of groups.values()){
    const pp = percentiles(g.map(s => s.plays)), pl = percentiles(g.map(s => s.playlists));
    for (const s of g) s.score = Math.round(1000 * (playsWeight * pp(s.plays) + playlistsWeight * pl(s.playlists))) / 1000;
    g.sort((a, b) => b.score - a.score);
    const easy = Math.round(g.length * CFG.tiers.easy), medium = easy + Math.round(g.length * CFG.tiers.medium);
    g.forEach((s, i) => { s.tier = i < easy ? "easy" : i < medium ? "medium" : "hard"; });
  }
}

const COLS = ["id", "title", "film", "year", "yearVerified", "language", "singers", "composers", "lyricists", "starring", "albumId", "plays", "score", "tier"];

(async () => {
  const t0 = Date.now();
  console.log("loading wikidata film index...");
  const index = await loadFilms();
  const M = makeMatcher(index);

  console.log("finding editorial playlists...");
  const playlists = await findPlaylists();
  console.log(`${playlists.length} playlists (${playlists.filter(p => p.chart).length} charts)`);
  const seed = await harvest(playlists);
  console.log(`seed: ${seed.size} unique songs`);

  const reasons = {}, report = [];
  const byKey = new Map(); // language + title key -> best entry
  let done = 0;
  await mapLimit([...seed.entries()], CFG.concurrency, async ([id, e]) => {
    let v;
    try { v = await classify(e.raw, M); }
    catch (err){ v = { reject: "error:" + String(err.message || err).slice(0, 60) }; }
    if (++done % 200 === 0) console.log(`  classified ${done}/${seed.size}`);
    if (v.reject){
      reasons[v.reject] = (reasons[v.reject] || 0) + 1;
      if (REPORT) report.push({ id, title: de(e.raw.title), album: de(e.raw.more_info?.album), year: yearOf(e.raw), lang: e.raw.language, reject: v.reject });
      return;
    }
    const c = v.copy, mi = c.more_info || {};
    const song = {
      id: c.id, title: cleanTitle(c.title), film: v.film, year: v.year, yearVerified: v.yv, language: c.language,
      singers: names(c, "singer"), composers: names(c, "music"), lyricists: names(c, "lyricist"), starring: names(c, "starring"),
      albumId: String(mi.album_id || ""), plays: playsOf(c), playlists: e.pls,
    };
    if (REPORT) report.push({ id, resolvedId: c.id, title: song.title, film: song.film, year: song.year, yv: song.yearVerified, source: v.source, lang: song.language, album: de(mi.album) });
    const k = `${song.language}|${songKey(song.title)}`;
    const prev = byKey.get(k);
    if (prev){ prev.playlists = new Set([...prev.playlists, ...song.playlists]); if (song.plays > prev.plays) byKey.set(k, { ...song, playlists: prev.playlists }); }
    else byKey.set(k, song);
  });

  const songs = [...byKey.values()].map(s => ({ ...s, playlists: s.playlists.size }));
  scoreAndTier(songs);
  songs.sort((a, b) => a.language.localeCompare(b.language) || a.year - b.year || a.title.localeCompare(b.title));

  console.log("\nrejections:", reasons);
  const table = {};
  for (const s of songs){ const k = `${s.language} ${decadeOf(s.year)}`; table[k] = table[k] || { easy: 0, medium: 0, hard: 0, unverifiedYear: 0 }; table[k][s.tier]++; if (!s.yearVerified) table[k].unverifiedYear++; }
  console.table(table);
  for (const lang of Object.keys(LANGS)){
    const n = songs.filter(s => s.language === lang).length;
    if (n < CFG.minSongsPerLanguage){ console.error(`REFUSING to write ${OUT}: only ${n} ${lang} songs (< ${CFG.minSongsPerLanguage})`); process.exit(1); }
  }
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ reasons, songs: report }, null, 1));
  const head = JSON.stringify({ v: 1, built: new Date().toISOString(), tiers: CFG.tiers, cols: COLS });
  const rows = songs.map(s => JSON.stringify(COLS.map(c => s[c]))).join(",\n");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${head.slice(0, -1)},"songs":[\n${rows}\n]}\n`);
  console.log(`\nwrote ${OUT}: ${songs.length} songs in ${Math.round((Date.now() - t0) / 60000)}min`);
})().catch(e => { console.error("build-corpus failed:", e); process.exit(1); });
