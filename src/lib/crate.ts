/* Song loading.
   Primary: the curated corpus (corpus.json, verified film songs with popularity
   scores), resolved to JioSaavn streams by id (full songs, snippets start at the intro).
   Fallback 1: raw JioSaavn search (unverified years, no scores).
   Fallback 2: catalog.json baked into the site (rebuilt weekly by CI, 30s hook clips). */
import { SAAVN_BASES, SAAVN_QUERIES, SAAVN_PAGES, SAAVN_MIN_PLAYS, CORPUS_DRAW, CORPUS_BATCH, EXCLUDE_RX, ERAS, eraOf, SNIP_ACCEPTED, SNIP_WINDOW_SEC, SNIP_MAX_AGE_MS } from "./constants.js";
import { COOLDOWN_MIN_FRESH, DRAW_WEIGHT, POPULAR_MIN_SCORE } from "./config";
import { de, songKey, shuffle, safeUrl, displayTitle } from "./utils.js";
import { sanitizeTrack, loadHistory, cooldownOf, loadBlocked, normArtist, isBlocked, type Cooldown } from "./storage";
import { log, ms } from "./log.js";
import type { Category, Lang, Mix, Track } from "../types";

type Sound = "full" | "inst";
/* Song key -> how many of the people present heard it (a room's seated phones). */
type HeardBy = Record<string, number>;
type Snip = NonNullable<Track["snip"]>;

type CrateError = "load" | "thin" | "safe";
type CrateSource = "corpus" | "saavn" | "catalog";
export type Crate = { queue: Track[]; source: CrateSource } | { error: CrateError };

let saavnBase: string | null = null;
/* JioSaavn's JSON as the Worker or a mirror returns it; nothing in it is
   trusted until sanitizeTrack has checked the fields the game reads. */
async function saavnFetch(path: string): Promise<any> {
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
const pickStream = (dl: unknown): string | null => {
  if (!Array.isArray(dl)) return null;
  for (const q of ["96kbps","160kbps","48kbps","320kbps","12kbps"]){
    const hit = dl.find(x=>x.quality===q); if (hit && (hit.url||hit.link)) return hit.url||hit.link;
  }
  const any = dl.find(x=>x.url||x.link); return any ? (any.url||any.link) : null;
};
const pickArt = (img: unknown): string | null => Array.isArray(img) && img.length ? (img[img.length-1].url||img[img.length-1].link||null) : null;

/* corpus.json (docs/song-loading.md) is column-major-compact ({ v, built,
   tiers, cols, songs: [[...]] }); a row expanded by cols is a CorpusSong.
   Expand it once per page load. A missing or malformed file is tolerated
   (fallback tiers). */
interface CorpusSong {
  id: string;
  title: string;
  film: string;
  year: number;
  yearVerified: boolean;
  language: string;
  singers: string[];
  composers: string[];
  lyricists: string[];
  starring: string[];
  albumId: string;
  plays: number;
  score: number;
  tier: string;
  tags: Category[];
}
/* A corpus song in one of the chosen languages, with the artist line its track shows. */
type CorpusPick = CorpusSong & { lang: Lang; artist: string };
let corpusCache: { at: number; songs: CorpusSong[] } | null = null;
let corpusPending: Promise<CorpusSong[] | null> | null = null;
async function loadCorpus(): Promise<CorpusSong[] | null> {
  if (corpusCache && Date.now() - corpusCache.at < 3600e3) return corpusCache.songs;
  if (corpusPending) return corpusPending;
  corpusPending = fetchCorpus().finally(() => { corpusPending = null; });
  return corpusPending;
}
async function fetchCorpus(): Promise<CorpusSong[] | null> {
  try {
    const r = await fetch("./corpus.json", { cache:"no-cache", keepalive:true });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.v !== 1 || !Array.isArray(j.cols) || !Array.isArray(j.songs)) return null;
    const songs: CorpusSong[] = j.songs.map((row: unknown[]) => Object.fromEntries(j.cols.map((c: string, i: number)=>[c,row[i]])));
    corpusCache = { at: Date.now(), songs };
    return songs;
  } catch(e){ return null; }
}
const CORPUS_LANG: Record<string, Lang> = { hindi:"bolly", telugu:"telugu" };

const langsOf = (mix: Mix): Lang[] => mix==="both" ? ["bolly","telugu"] : [mix];

/* Corpus songs in the chosen languages and eras, not blocked, and (Music-only)
   in the snips index. */
function corpusEligible(corpus: CorpusSong[], langs: Lang[], eras: string[], blocked: Set<string>, safeIds: Set<string> | null): CorpusPick[] {
  const eraSet = Array.isArray(eras) && eras.length && eras.length < ERAS.length ? new Set(eras) : null;
  const eligible: CorpusPick[] = [];
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

/* The popular songs (POPULAR_MIN_SCORE), widened to every song when they are
   too few (not in Music-only, whose shortage the user has to see). */
function popularCands(eligible: CorpusPick[], safeIds: Set<string> | null, minSongs: number): CorpusPick[] {
  const cands = eligible.filter(s => s.score >= POPULAR_MIN_SCORE);
  return !safeIds && cands.length < minSongs ? eligible : cands;
}

const inCategories = (s: CorpusSong, categories: Category[]) => !categories.length || (Array.isArray(s.tags) && s.tags.some(t => categories.includes(t)));

/* Returns { status: "ok" | "none" | "thin" | "unresolved", pool }.
   "none" (no corpus) and "unresolved" (ids could not be turned into streams)
   fall through to the uncurated tiers; "thin" is a filter problem the user
   must widen, not a reason to play unverified songs. */
async function loadFromCorpus(langs: Lang[], eras: string[], blocked: Set<string>, cooldown: Cooldown, heardBy: HeardBy, safeIds: Set<string> | null, minSongs: number, categories: Category[]): Promise<{ status: "ok" | "none" | "thin" | "unresolved"; pool: Track[] }> {
  const corpus = await loadCorpus();
  if (!corpus) return { status:"none", pool:[] };
  const eligible = corpusEligible(corpus, langs, eras, blocked, safeIds).filter(s => inCategories(s, categories));
  const cands = popularCands(eligible, safeIds, minSongs);
  if (cands.length < minSongs) return { status:"thin", pool:[] };
  const { fresh, stale } = splitCooldown(cands, s => songKey(s.title), cooldown, heardBy);
  const draw: CorpusPick[] = weightedShuffle(fresh, s => s.score).concat(stale).slice(0, Math.max(CORPUS_DRAW, minSongs * 2));
  const batches: CorpusPick[][] = [];
  for (let i = 0; i < draw.length; i += CORPUS_BATCH) batches.push(draw.slice(i, i + CORPUS_BATCH));
  const results = await Promise.allSettled(batches.map(b => saavnFetch(`/songs?ids=${b.map(s=>s.id).join(",")}`)));
  const byId = new Map<string, any>();
  for (const res of results){
    if (res.status !== "fulfilled" || !res.value) continue;
    const list = Array.isArray(res.value.data) ? res.value.data : [];
    for (const r of list) if (r && r.id) byId.set(r.id, r);
  }
  const pool: (Track | null)[] = [];
  for (const s of draw){
    const r = byId.get(s.id);
    if (!r) continue;
    const stream = safeUrl(pickStream(r.downloadUrl));
    if (!stream) continue;
    pool.push(sanitizeTrack({
      title:s.title, artist:s.artist, album:s.film, art:pickArt(r.image), stream,
      duration:parseInt(r.duration)||200, year:s.year, lang:s.lang, score:s.score,
      music:(s.composers||[]).join(", "), sourceId:r.id === s.id ? s.id : "",
    }));
  }
  const ok = pool.filter(t => t !== null);
  return { status: ok.length >= minSongs ? "ok" : "unresolved", pool: ok };
}

async function loadFromSaavn(langs: Lang[]): Promise<Track[]> {
  const jobs: { q: string; page: number; lang: Lang }[] = [];
  for (const lang of langs){
    const all = SAAVN_QUERIES[lang].flatMap(q => Array.from({ length:SAAVN_PAGES }, (_,i)=>({ q, page:i+1, lang })));
    jobs.push(...shuffle(all).slice(0,7));
  }
  const seen = new Set<string>(); const pool: (Track | null)[] = [];
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
      const artists = (s.artists?.primary || []).map((a: any)=>de(a.name)).filter(Boolean);
      pool.push(sanitizeTrack({
        title:name, artist:artists.slice(0,3).join(", ")||"Unknown artist",
        album:de(s.album?.name||""), art:pickArt(s.image), stream,
        duration:parseInt(s.duration)||200, year, lang, sourceId:s.id,
      }));
    }
  }
  return pool.filter(t => t !== null);
}

async function loadCatalog(langs: Lang[]): Promise<Track[]> {
  try {
    const r = await fetch("./catalog.json", { cache:"no-cache" });
    if (!r.ok) return [];
    const j = await r.json();
    const rows: any[] = Array.isArray(j.tracks) ? j.tracks : [];
    const tracks = rows.map(t=>sanitizeTrack({ ...t, hook:true })).filter(t => t !== null);
    return tracks.filter(t => langs.includes(t.lang));
  } catch(e){ return []; }
}

/* The offline-scored source-bound index (see docs/audio.md): one vocal-free
   window per Saavn recording id, keyed by that id. */
interface SnipEntry { sourceId: string; startSec: number; endSec: number; method: string; vocalDb?: number; maxVoice?: number; limitDb?: number }
interface SnipsIndex { v: number; built: string; snips: Record<string, SnipEntry> }
let snipsCache: { at: number; index: SnipsIndex } | null = null;
let snipsPending: Promise<SnipsIndex | null> | null = null;
async function loadSnips(fresh = false): Promise<SnipsIndex | null> {
  if (!fresh && snipsCache && Date.now() - snipsCache.at < 300e3) return snipsCache.index;
  if (snipsPending) return snipsPending;
  snipsPending = fetchSnips().finally(() => { snipsPending = null; });
  return snipsPending;
}
async function fetchSnips(): Promise<SnipsIndex | null> {
  try {
    const r = await fetch("./snips.json", { cache:"no-cache", keepalive:true });
    if (!r.ok) return null;
    const j = await r.json();
    const age = Date.now() - Date.parse(j?.built);
    const index: SnipsIndex | null = (j && Object.hasOwn(SNIP_ACCEPTED, j.v) && Number.isFinite(age) && age >= 0 && age <= SNIP_MAX_AGE_MS && j.snips &&
      typeof j.snips === "object" && !Array.isArray(j.snips)) ? j : null;
    if (index) snipsCache = { at: Date.now(), index };
    return index;
  } catch(e){ return null; }
}

function verifiedSnip(t: { sourceId?: string; hook?: boolean; duration: number }, index: SnipsIndex | null): Snip | null {
  if (!index || !t.sourceId || t.hook) return null;
  const e = index.snips[t.sourceId], accept = SNIP_ACCEPTED[index.v];
  if (!e || !accept || e.sourceId !== t.sourceId || e.method !== accept.method ||
      !Number.isFinite(e.startSec) || !Number.isFinite(e.endSec) || !accept.clean(e) ||
      e.startSec < 0 || e.endSec - e.startSec !== SNIP_WINDOW_SEC ||
      e.endSec + 1 > t.duration) return null;
  return { startSec:e.startSec, endSec:e.endSec, sourceId:t.sourceId, method:accept.method, indexBuilt:index.built };
}

export async function refreshMusicQueue(queue: Track[]): Promise<Track[]> {
  const index = await loadSnips(true);
  return queue.map(t => ({ ...t, snip:verifiedSnip(t, index) || undefined })).filter(t => t.snip);
}

/* A shuffle that favours the songs people know (DRAW_WEIGHT): each song's
   chance of coming first is proportional to (score + floor) ^ power, with
   score its popularity percentile within its language and decade. Songs
   without a score (the fallback tiers) draw as if they sat in the middle.
   (Each song gets the key random ^ (1 / weight); sorting by key is a
   weighted draw without replacement.) */
function weightedShuffle<T>(list: T[], scoreOf: (t: T) => number | undefined): T[] {
  const { power, floor } = DRAW_WEIGHT;
  const weight = (t: T) => ((scoreOf(t) ?? 0.5) + floor) ** power;
  return list.map(t => ({ t, k: Math.random() ** (1 / weight(t)) })).sort((a, b) => b.k - a.k).map(x => x.t);
}

/* Songs still sitting out go after every fresh one; among them the ones the
   fewest people present have heard come first, then the soonest due. */
function splitCooldown<T>(list: T[], keyOf: (t: T) => string, cooldown: Cooldown, heardBy: HeardBy): { fresh: T[]; stale: T[] } {
  const now = Date.now();
  const fresh: T[] = [], stale: T[] = [];
  for (const t of list) ((cooldown[keyOf(t)] || 0) > now ? stale : fresh).push(t);
  stale.sort((a,b) => ((heardBy[keyOf(a)] || 0) - (heardBy[keyOf(b)] || 0)) || (cooldown[keyOf(a)] - cooldown[keyOf(b)]));
  return { fresh, stale };
}

/* Returns { queue, source } or { error: "load" | "thin" | "safe" }.
   The corpus tier draws the popular songs (POPULAR_MIN_SCORE); the uncurated
   fallback tiers carry no score and ignore it.
   cooldown: song key -> the time it may come back (cooldownOf), this
   phone's own unless the caller merged a group's or a room's in;
   heardBy: song key -> how many of the people present heard it.
   categories: corpus tags, any of which a song must carry; [] means every
   song. The fallback tiers carry no tags, so with categories set they never
   run and an unreachable corpus is a load error. */
export async function buildCrate(mix: Mix, eras: string[], sound: Sound, minSongs = 10, cooldown: Cooldown = cooldownOf(loadHistory()), categories: Category[] = [], heardBy: HeardBy = {}): Promise<Crate> {
  const t0 = performance.now();
  const langs = langsOf(mix);
  const key = (t: Track) => songKey(t.title);
  const snips = await loadSnips();
  if (sound === "inst" && (!snips || !Object.keys(snips.snips).length)){
    log("crate", { mix, sound, source:"index", snips:"none", snipped:0, ms:ms(t0) });
    return { error:"safe" };
  }
  const blocked = new Set(loadBlocked().map(normArtist));
  const safeIds = sound === "inst" ? new Set(Object.keys(snips?.snips || {})) : null;
  const corpus = await loadFromCorpus(langs, eras, blocked, cooldown, heardBy, safeIds, minSongs, categories);
  const tiers: Record<string, number | string> = { corpus: corpus.status === "ok" ? corpus.pool.length : corpus.status };
  if (corpus.status === "thin"){
    log("crate", { mix, sound, categories, source:"corpus", ...tiers, ms: ms(t0) });
    return { error:sound === "inst" ? "safe" : "thin" };
  }
  if (categories.length && corpus.status !== "ok"){
    log("crate", { mix, sound, categories, source:"corpus", ...tiers, ms: ms(t0) });
    return { error:"load" };
  }
  let pool = corpus.pool;
  let source: CrateSource = "corpus";
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
    const seen = new Set<string>();
    pool = pool.filter(t => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  // Bind intervals only to the recording ID resolved for this crate.
  let snipped = 0;
  if (snips) for (const t of pool){
    const verified = verifiedSnip(t, snips);
    if (verified){ t.snip = verified; snipped++; }
  }
  log("crate", { mix, sound, categories, source, ...tiers, snips: snips ? "ok" : "none", snipped, cooldown: Object.keys(cooldown).length, ms: ms(t0) });
  if (pool.length < minSongs && sound !== "inst") return { error:"load" };
  if (Array.isArray(eras) && eras.length && eras.length < ERAS.length)
    pool = pool.filter(t => eras.includes(eraOf(t.year)));
  if (blocked.size) pool = pool.filter(t => !isBlocked(t, blocked));
  if (sound === "inst") pool = pool.filter(t => t.snip);
  if (pool.length < minSongs) return { error:sound === "inst" ? "safe" : "thin" };
  // Songs still cooling down (this phone, the group, a room's phones) sit out; when the fresh pool
  // runs thin, or can't fill the show on its own, repeats come back after all fresh songs (splitCooldown).
  const { fresh, stale } = splitCooldown(pool, key, cooldown, heardBy);
  const drawn = weightedShuffle(fresh, t => t.score);
  let queue: Track[] = fresh.length >= Math.max(COOLDOWN_MIN_FRESH, minSongs) ? drawn : drawn.concat(stale);
  // A full show's worth of verified tracks is required before the game starts.
  if (queue.length < minSongs) return { error:sound === "inst" ? "safe" : "thin" };
  return { queue, source };
}

/* How many corpus songs each category offers the corpus tier for these
   settings, counted the way loadFromCorpus picks them. null when the corpus
   (or, for Music-only, the snips index) is unavailable. */
export async function categoryCounts(mix: Mix, eras: string[], sound: Sound, minSongs: number, categories: Category[]): Promise<Record<string, number> | null> {
  const corpus = await loadCorpus();
  if (!corpus) return null;
  let safeIds: Set<string> | null = null;
  if (sound === "inst"){
    const index = await loadSnips();
    if (!index) return null;
    safeIds = new Set(Object.keys(index.snips).filter(id => verifiedSnip({ sourceId:id, duration:Infinity }, index)));
  }
  const blocked = new Set(loadBlocked().map(normArtist));
  const eligible = corpusEligible(corpus, langsOf(mix), eras, blocked, safeIds);
  const count = (cats: Category[]) => popularCands(eligible.filter(s => inCategories(s, cats)), safeIds, minSongs).length;
  return Object.fromEntries([...categories.map(c => [c, count([c])]), ["any", count([])]]);
}

/* One entry of a buzz-in phone's answer list: a song title with the films
   it is from, or (film: true) a film, which scores part of the points. */
export interface AnswerEntry { title: string; films: string[]; year: number; film?: true }

/* The film a track is from: "Sitaare (From "Ikkis") - Single" is Ikkis, and
   a soundtrack album loses "(Original Motion Picture Soundtrack)". Anything
   else (a compilation, a single) stays as it is and is not offered as a film. */
const FROM = /\(From "([^"]+)"\)/i;
const OST = /\s*\((?:Original Motion Picture )?Soundtrack\)/i;
export function filmOf(album: string, title = ""): string {
  const from = FROM.exec(album) || FROM.exec(title);
  return from ? from[1].trim() : album.replace(OST, "").replace(/\s+-\s+(?:Single|EP)$/i, "").trim();
}
const isFilmAlbum = (album: string, title: string) => FROM.test(album) || FROM.test(title) || OST.test(album);

/* Every song and film a buzz-in phone can pick from: the public corpus and
   the baked catalog for the show's languages. It never depends on the show,
   so the list says nothing about which songs are coming. A title from
   several films is one entry naming them all, since a title is judged as a
   title; a film that is also a song title is left to the song's entry. */
export async function answerTitles(mix: Mix): Promise<AnswerEntry[]> {
  const langs = langsOf(mix);
  const [corpus, catalog] = await Promise.all([loadCorpus(), loadCatalog(langs)]);
  const songs = new Map<string, AnswerEntry>(), films = new Map<string, AnswerEntry>();
  const add = (title: string, film: string, year: number, isFilm: boolean) => {
    const d = displayTitle(title), k = songKey(d), fk = songKey(film);
    if (!k) return;
    let e = songs.get(k);
    if (!e) songs.set(k, e = { title: d, films: [], year: year || 0 });
    if (fk && !e.films.some(f => songKey(f) === fk)) e.films.push(film);
    if (year > 0 && (!e.year || year < e.year)) e.year = year;
    if (isFilm && fk && !films.has(fk)) films.set(fk, { title: film, films: [], year: year || 0, film: true });
  };
  for (const s of corpus || []) if (langs.includes(CORPUS_LANG[s.language])) add(s.title, s.film, s.year, true);
  for (const t of catalog) add(t.title, filmOf(t.album, t.title), t.year, isFilmAlbum(t.album, t.title));
  return [...songs.values(), ...[...films].filter(([k]) => !songs.has(k)).map(([, f]) => f)];
}

/* The queue with the song at idx swapped for the first later one that is not
   cooling down, when it is (a phone that joined a room after the crate was
   built heard it); the same queue otherwise. */
export function withFreshAt(queue: Track[], idx: number, cooldown: Cooldown): Track[] {
  const now = Date.now();
  const cooling = (t: Track) => (cooldown[songKey(t.title)] || 0) > now;
  if (!queue[idx] || !cooling(queue[idx])) return queue;
  const j = queue.findIndex((t, i) => i > idx && !cooling(t));
  if (j < 0) return queue;
  const q = queue.slice();
  [q[idx], q[j]] = [q[j], q[idx]];
  return q;
}
