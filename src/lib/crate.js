/* Song loading.
   Primary: the curated corpus (corpus.json, verified film songs with difficulty
   tiers), resolved to JioSaavn streams by id (full songs, snippets start at the intro).
   Fallback 1: raw JioSaavn search (unverified years, no tiers).
   Fallback 2: catalog.json baked into the site (rebuilt weekly by CI, 30s hook clips). */
import { SAAVN_BASES, SAAVN_QUERIES, SAAVN_PAGES, SAAVN_MIN_PLAYS, CORPUS_DRAW, CORPUS_BATCH, DIFFICULTY_TIERS, EXCLUDE_RX, ERAS, eraOf, SNIP_ACCEPTED, SNIP_WINDOW_SEC, SNIP_MAX_AGE_MS } from "./constants.js";
import { COOLDOWN_MIN_FRESH } from "./config";
import { de, songKey, shuffle, safeUrl, displayTitle } from "./utils.js";
import { sanitizeTrack, loadHistory, cooldownOf, loadBlocked, normArtist, isBlocked } from "./storage.js";
import { log, ms } from "./log.js";

let saavnBase = null;
async function saavnFetch(path){
  const bases = saavnBase ? [saavnBase, ...SAAVN_BASES.filter(x=>x!==saavnBase)] : SAAVN_BASES;
  for (const b of bases){
    try {
      const ctl = new AbortController();
      const to = setTimeout(()=>ctl.abort(), 6000);
      const r = await fetch(b + path, { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.data || j.results)){ saavnBase = b; return j; }
    } catch(e){}
  }
  return null;
}
const pickStream = dl => {
  if (!Array.isArray(dl)) return null;
  for (const q of ["96kbps","160kbps","48kbps","320kbps","12kbps"]){
    const hit = dl.find(x=>x.quality===q); if (hit && (hit.url||hit.link)) return hit.url||hit.link;
  }
  const any = dl.find(x=>x.url||x.link); return any ? (any.url||any.link) : null;
};
const pickArt = img => Array.isArray(img) && img.length ? (img[img.length-1].url||img[img.length-1].link||null) : null;

/* corpus.json is column-major-compact ({ cols, songs: [[...]] }); expand it
   once per page load. A missing or malformed file is tolerated (fallback tiers). */
let corpusCache = null;
let corpusPending = null;
async function loadCorpus(){
  if (corpusCache && Date.now() - corpusCache.at < 3600e3) return corpusCache.songs;
  if (corpusPending) return corpusPending;
  corpusPending = fetchCorpus().finally(() => { corpusPending = null; });
  return corpusPending;
}
async function fetchCorpus(){
  try {
    const r = await fetch("./corpus.json", { cache:"no-cache", keepalive:true });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.v !== 1 || !Array.isArray(j.cols) || !Array.isArray(j.songs)) return null;
    const songs = j.songs.map(row => Object.fromEntries(j.cols.map((c,i)=>[c,row[i]])));
    corpusCache = { at: Date.now(), songs };
    return songs;
  } catch(e){ return null; }
}
const CORPUS_LANG = { hindi:"bolly", telugu:"telugu" };

const langsOf = mix => mix==="both" ? ["bolly","telugu"] : [mix];

/* Corpus songs in the chosen languages and eras, not blocked, and (Music-only)
   in the snips index. */
function corpusEligible(corpus, langs, eras, blocked, safeIds){
  const eraSet = Array.isArray(eras) && eras.length && eras.length < ERAS.length ? new Set(eras) : null;
  const eligible = [];
  for (const s of corpus){
    const lang = CORPUS_LANG[s.language];
    if (!langs.includes(lang)) continue;
    if (safeIds && !safeIds.has(s.id)) continue;
    if (eraSet && !eraSet.has(eraOf(s.year))) continue;
    const artist = (s.singers || []).slice(0,3).join(", ") || "Unknown artist";
    if (blocked.size && isBlocked({ artist }, blocked)) continue;
    eligible.push({ ...s, lang, artist });
  }
  return eligible;
}

/* The difficulty's tiers, widened to every tier when they hold too few songs
   (not in Music-only, whose shortage the user has to see). */
function difficultyCands(eligible, difficulty, safeIds, minSongs){
  const tiers = new Set(DIFFICULTY_TIERS[difficulty] || DIFFICULTY_TIERS.mixed);
  const cands = eligible.filter(s => tiers.has(s.tier));
  return !safeIds && cands.length < minSongs ? eligible : cands;
}

const inCategories = (s, categories) => !categories.length || (Array.isArray(s.tags) && s.tags.some(t => categories.includes(t)));

/* Returns { status: "ok" | "none" | "thin" | "unresolved", pool }.
   "none" (no corpus) and "unresolved" (ids could not be turned into streams)
   fall through to the uncurated tiers; "thin" is a filter problem the user
   must widen, not a reason to play unverified songs. */
async function loadFromCorpus(langs, eras, difficulty, blocked, cooldown, heardBy, safeIds, minSongs, categories){
  const corpus = await loadCorpus();
  if (!corpus) return { status:"none", pool:[] };
  const eligible = corpusEligible(corpus, langs, eras, blocked, safeIds).filter(s => inCategories(s, categories));
  const cands = difficultyCands(eligible, difficulty, safeIds, minSongs);
  if (cands.length < minSongs) return { status:"thin", pool:[] };
  const { fresh, stale } = splitCooldown(cands, s => songKey(s.title), cooldown, heardBy);
  const draw = shuffle(fresh).concat(stale).slice(0, Math.max(CORPUS_DRAW, minSongs * 2));
  const batches = [];
  for (let i = 0; i < draw.length; i += CORPUS_BATCH) batches.push(draw.slice(i, i + CORPUS_BATCH));
  const results = await Promise.allSettled(batches.map(b => saavnFetch(`/songs?ids=${b.map(s=>s.id).join(",")}`)));
  const byId = new Map();
  for (const res of results){
    if (res.status !== "fulfilled" || !res.value) continue;
    const list = Array.isArray(res.value.data) ? res.value.data : [];
    for (const r of list) if (r && r.id) byId.set(r.id, r);
  }
  const pool = [];
  for (const s of draw){
    const r = byId.get(s.id);
    if (!r) continue;
    const stream = safeUrl(pickStream(r.downloadUrl));
    if (!stream) continue;
    pool.push(sanitizeTrack({
      title:s.title, artist:s.artist, album:s.film, art:pickArt(r.image), stream,
      duration:parseInt(r.duration)||200, year:s.year, lang:s.lang, tier:s.tier,
      music:(s.composers||[]).join(", "), sourceId:r.id === s.id ? s.id : "",
    }));
  }
  const ok = pool.filter(Boolean);
  return { status: ok.length >= minSongs ? "ok" : "unresolved", pool: ok };
}

async function loadFromSaavn(langs){
  const jobs = [];
  for (const lang of langs){
    const all = SAAVN_QUERIES[lang].flatMap(q => Array.from({ length:SAAVN_PAGES }, (_,i)=>({ q, page:i+1, lang })));
    jobs.push(...shuffle(all).slice(0,7));
  }
  const seen = new Set(); const pool = [];
  const results = await Promise.allSettled(jobs.map(j =>
    saavnFetch(`/search/songs?query=${encodeURIComponent(j.q)}&limit=40&page=${j.page}`).then(r=>({r, lang:j.lang}))
  ));
  for (const res of results){
    if (res.status!=="fulfilled" || !res.value.r) continue;
    const lang = res.value.lang;
    const list = res.value.r.data?.results || res.value.r.results || [];
    for (const s of list){
      const name = de(s.name || s.title || "");
      if (!name) continue;
      if ((s.language||"").toLowerCase() !== (lang==="bolly"?"hindi":"telugu")) continue;
      const year = parseInt(s.year) || 0;
      if (year < 2000) continue;
      const plays = parseInt(s.playCount) || 0;
      if (plays && plays < SAAVN_MIN_PLAYS) continue;
      if (EXCLUDE_RX.test(name)) continue;
      const stream = safeUrl(pickStream(s.downloadUrl));
      if (!stream) continue;
      const key = songKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      const artists = (s.artists?.primary || []).map(a=>de(a.name)).filter(Boolean);
      pool.push(sanitizeTrack({
        title:name, artist:artists.slice(0,3).join(", ")||"Unknown artist",
        album:de(s.album?.name||""), art:pickArt(s.image), stream,
        duration:parseInt(s.duration)||200, year, lang, sourceId:s.id,
      }));
    }
  }
  return pool.filter(Boolean);
}

async function loadCatalog(langs){
  try {
    const r = await fetch("./catalog.json", { cache:"no-cache" });
    if (!r.ok) return [];
    const j = await r.json();
    const tracks = (Array.isArray(j.tracks) ? j.tracks : []).map(t=>sanitizeTrack({ ...t, hook:true })).filter(Boolean);
    return tracks.filter(t => langs.includes(t.lang));
  } catch(e){ return []; }
}

/* The offline-scored source-bound index (see docs/audio.md). */
let snipsCache = null;
let snipsPending = null;
async function loadSnips(fresh = false){
  if (!fresh && snipsCache && Date.now() - snipsCache.at < 300e3) return snipsCache.index;
  if (snipsPending) return snipsPending;
  snipsPending = fetchSnips().finally(() => { snipsPending = null; });
  return snipsPending;
}
async function fetchSnips(){
  try {
    const r = await fetch("./snips.json", { cache:"no-cache", keepalive:true });
    if (!r.ok) return null;
    const j = await r.json();
    const age = Date.now() - Date.parse(j?.built);
    const index = (j && Object.hasOwn(SNIP_ACCEPTED, j.v) && Number.isFinite(age) && age >= 0 && age <= SNIP_MAX_AGE_MS && j.snips &&
      typeof j.snips === "object" && !Array.isArray(j.snips)) ? j : null;
    if (index) snipsCache = { at: Date.now(), index };
    return index;
  } catch(e){ return null; }
}

function verifiedSnip(t, index){
  if (!index || !t.sourceId || t.hook) return null;
  const e = index.snips[t.sourceId], accept = SNIP_ACCEPTED[index.v];
  if (!e || !accept || e.sourceId !== t.sourceId || e.method !== accept.method ||
      !Number.isFinite(e.startSec) || !Number.isFinite(e.endSec) || !accept.clean(e) ||
      e.startSec < 0 || e.endSec - e.startSec !== SNIP_WINDOW_SEC ||
      e.endSec + 1 > t.duration) return null;
  return { startSec:e.startSec, endSec:e.endSec, sourceId:t.sourceId, method:accept.method, indexBuilt:index.built };
}

export async function refreshMusicQueue(queue){
  const index = await loadSnips(true);
  return queue.map(t => ({ ...t, snip:verifiedSnip(t, index) || undefined })).filter(t => t.snip);
}

/* Songs still sitting out go after every fresh one; among them the ones the
   fewest people present have heard come first, then the soonest due. */
function splitCooldown(list, keyOf, cooldown, heardBy){
  const now = Date.now();
  const fresh = [], stale = [];
  for (const t of list) ((cooldown[keyOf(t)] || 0) > now ? stale : fresh).push(t);
  stale.sort((a,b) => ((heardBy[keyOf(a)] || 0) - (heardBy[keyOf(b)] || 0)) || (cooldown[keyOf(a)] - cooldown[keyOf(b)]));
  return { fresh, stale };
}

/* Returns { queue, source } or { error: "load" | "thin" | "safe" }.
   difficulty: "easy" | "medium" | "hard" | "mixed" (corpus tiers; the
   uncurated fallback tiers carry no difficulty and ignore it).
   cooldown: song key -> the time it may come back (cooldownOf), this
   phone's own unless the caller merged a group's or a room's in;
   heardBy: song key -> how many of the people present heard it.
   categories: corpus tags, any of which a song must carry; [] means every
   song. The fallback tiers carry no tags, so with categories set they never
   run and an unreachable corpus is a load error. */
export async function buildCrate(mix, eras, sound, difficulty = "mixed", minSongs = 10, cooldown = cooldownOf(loadHistory()), categories = [], heardBy = {}){
  const t0 = performance.now();
  const langs = langsOf(mix);
  const key = t => songKey(t.title);
  const snips = await loadSnips();
  if (sound === "inst" && (!snips || !Object.keys(snips.snips).length)){
    log("crate", { mix, difficulty, source:"index", snips:"none", snipped:0, ms:ms(t0) });
    return { error:"safe" };
  }
  const blocked = new Set(loadBlocked().map(normArtist));
  const safeIds = sound === "inst" ? new Set(Object.keys(snips?.snips || {})) : null;
  const corpus = await loadFromCorpus(langs, eras, difficulty, blocked, cooldown, heardBy, safeIds, minSongs, categories);
  const tiers = { corpus: corpus.status === "ok" ? corpus.pool.length : corpus.status };
  if (corpus.status === "thin"){
    log("crate", { mix, difficulty, categories, source:"corpus", ...tiers, ms: ms(t0) });
    return { error:sound === "inst" ? "safe" : "thin" };
  }
  if (categories.length && corpus.status !== "ok"){
    log("crate", { mix, difficulty, categories, source:"corpus", ...tiers, ms: ms(t0) });
    return { error:"load" };
  }
  let pool = corpus.pool;
  let source = "corpus";
  if (pool.length < minSongs){
    const searched = await loadFromSaavn(langs);
    pool = sound === "inst" ? pool.concat(searched) : searched;
    if (sound !== "inst" || !corpus.pool.length) source = "saavn";
    tiers.saavn = searched.length;
  }
  if (pool.length < minSongs && sound !== "inst"){
    const keys = new Set(pool.map(key));
    const backup = (await loadCatalog(langs)).filter(t=>!keys.has(key(t)));
    tiers.catalog = backup.length;
    if (!pool.length) source = "catalog";
    pool = pool.concat(backup);
  }
  // Belt-and-braces dedupe of the whole pool: catalog.json itself can carry
  // near-duplicate titles, and per-tier dedupe can't see across sources.
  // First occurrence wins, so full Saavn songs beat 30s hook clips.
  {
    const seen = new Set();
    pool = pool.filter(t => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Bind intervals only to the recording ID resolved for this crate.
  let snipped = 0;
  if (snips) for (const t of pool){
    const verified = verifiedSnip(t, snips);
    if (verified){ t.snip = verified; snipped++; }
  }
  log("crate", { mix, difficulty, categories, source, ...tiers, snips: snips ? "ok" : "none", snipped, cooldown: Object.keys(cooldown).length, ms: ms(t0) });
  if (pool.length < minSongs && sound !== "inst") return { error:"load" };
  if (Array.isArray(eras) && eras.length && eras.length < ERAS.length)
    pool = pool.filter(t => eras.includes(eraOf(t.year)));
  if (blocked.size) pool = pool.filter(t => !isBlocked(t, blocked));
  if (sound === "inst") pool = pool.filter(t => t.snip);
  if (pool.length < minSongs) return { error:sound === "inst" ? "safe" : "thin" };
  // Songs still cooling down (this phone, the group, a room's phones) sit out; when the fresh pool
  // runs thin, repeats come back after all fresh songs (splitCooldown).
  const { fresh, stale } = splitCooldown(pool, key, cooldown, heardBy);
  let queue = fresh.length >= COOLDOWN_MIN_FRESH ? shuffle(fresh) : shuffle(fresh).concat(stale);
  // A full show's worth of verified tracks is required before the game starts.
  if (queue.length < minSongs) return { error:sound === "inst" ? "safe" : "thin" };
  return { queue, source };
}

/* How many corpus songs each category offers the corpus tier for these
   settings, counted the way loadFromCorpus picks them. null when the corpus
   (or, for Music-only, the snips index) is unavailable. */
export async function categoryCounts(mix, eras, sound, difficulty, minSongs, categories){
  const corpus = await loadCorpus();
  if (!corpus) return null;
  let safeIds = null;
  if (sound === "inst"){
    const index = await loadSnips();
    if (!index) return null;
    safeIds = new Set(Object.keys(index.snips).filter(id => verifiedSnip({ sourceId:id, duration:Infinity }, index)));
  }
  const blocked = new Set(loadBlocked().map(normArtist));
  const eligible = corpusEligible(corpus, langsOf(mix), eras, blocked, safeIds);
  const count = cats => difficultyCands(eligible.filter(s => inCategories(s, cats)), difficulty, safeIds, minSongs).length;
  return Object.fromEntries([...categories.map(c => [c, count([c])]), ["any", count([])]]);
}

/* Every title a buzz-in phone can pick from: the public corpus and the
   baked catalog for the show's languages. It never depends on the show, so
   the list says nothing about which songs are coming. */
export async function answerTitles(mix){
  const langs = langsOf(mix);
  const [corpus, catalog] = await Promise.all([loadCorpus(), loadCatalog(langs)]);
  const seen = new Set(), out = [];
  const add = title => {
    const d = displayTitle(title), k = songKey(d);
    if (k && !seen.has(k)){ seen.add(k); out.push(d); }
  };
  for (const s of corpus || []) if (langs.includes(CORPUS_LANG[s.language])) add(s.title);
  for (const t of catalog) add(t.title);
  return out;
}

/* The queue with the next song swapped for the first later one from the
   same corpus tier as the song at idx (tierless fallback songs match each
   other), one not cooling down when there is one, or null when none is left.
   A "Heard it too much" skip takes its replacement from here, so skipping a
   hard song can't fish for an easy one. */
export function withSameTierNext(queue, idx, cooldown = {}){
  const tier = queue[idx]?.tier;
  const now = Date.now();
  const later = (t, i) => i > idx && t.tier === tier;
  let j = queue.findIndex((t, i) => later(t, i) && !((cooldown[songKey(t.title)] || 0) > now));
  if (j < 0) j = queue.findIndex(later);
  if (j < 0) return null;
  const q = queue.slice();
  [q[idx + 1], q[j]] = [q[j], q[idx + 1]];
  return q;
}

/* The queue with the song at idx swapped for the first later one of its tier
   that is not cooling down, when it is (a phone that joined a room after the
   crate was built heard it); the same queue otherwise. */
export function withFreshAt(queue, idx, cooldown){
  const now = Date.now();
  const cooling = t => (cooldown[songKey(t.title)] || 0) > now;
  if (!queue[idx] || !cooling(queue[idx])) return queue;
  const j = queue.findIndex((t, i) => i > idx && t.tier === queue[idx].tier && !cooling(t));
  if (j < 0) return queue;
  const q = queue.slice();
  [q[idx], q[j]] = [q[j], q[idx]];
  return q;
}
