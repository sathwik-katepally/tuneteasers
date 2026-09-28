/* Device-local stores (localStorage): track sanitization, the recent-play
   cooldown and the blocked-artist list. A ticket (me.ts) mirrors the blocked
   list here so the game works with the Worker unreachable.
   The saved game itself lives in save.ts. */
import { DIFFICULTIES, SNIP_WINDOW_SEC } from "./constants.js";
import { COOLDOWN_DAYS } from "./config.ts";
import { songKey, safeUrl } from "./utils.js";

const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs } — this phone's recently heard songs
const LS_TIRED = "tt_tired";     // { titleKey: lastSkippedMs } — songs skipped here as heard too often
const LS_BLOCKED = "tt_blocked"; // [ artistName ] — device-local "never play this artist" list
const HISTORY_KEEP_MS = 30*24*3600*1000;
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

export function sanitizeTrack(t){
  const stream = safeUrl(t && t.stream); if (!stream) return null;
  return {
    title: String(t.title||"").slice(0,120),
    artist: String(t.artist||"").slice(0,120),
    album: String(t.album||"").slice(0,120),
    art: safeUrl(t.art),
    stream,
    duration: parseInt(t.duration)||200,
    year: parseInt(t.year)||0,
    lang: t.lang==="telugu" ? "telugu" : "bolly",
    hook: !!t.hook, // true when the stream is a mid-song preview clip, not the intro
    ...(DIFFICULTIES.includes(t.tier) && t.tier !== "mixed" ? { tier: t.tier } : {}),
    ...(typeof t.sourceId === "string" && t.sourceId ? { sourceId: t.sourceId } : {}),
    ...(t.snip && t.sourceId === t.snip.sourceId && typeof t.snip.indexBuilt === "string" &&
      Number.isFinite(t.snip.startSec) && Number.isFinite(t.snip.endSec) &&
      t.snip.startSec >= 0 && t.snip.endSec - t.snip.startSec === SNIP_WINDOW_SEC
      ? { snip: { startSec:t.snip.startSec, endSec:t.snip.endSec, sourceId:t.sourceId, indexBuilt:t.snip.indexBuilt } } : {}),
    ...(t.music ? { music: String(t.music).slice(0,120) } : {}),
  };
}

export const PLAY_COOLDOWN = COOLDOWN_DAYS.played*24*3600*1000;
const DAY = 24*3600*1000;
export function loadPlayed(){ return loadMap(LS_PLAYED); }
export function loadTired(){ return loadMap(LS_TIRED); }
/* This phone's own history, per kind. */
export const loadHistory = () => ({ played: loadPlayed(), tired: loadTired() });
function loadMap(key){
  const raw = lsGet(key);
  if (Array.isArray(raw)){ // migrate the old list format: treat every entry as just played
    const m = {}; const t = Date.now();
    for (const k of raw) if (typeof k === "string") m[songKey(k)] = t;
    return m;
  }
  if (!raw || typeof raw !== "object") return {};
  // Re-key through songKey: entries written before the key normalization
  // strengthened (e.g. 'song - from "movie"') collapse to the current key.
  const m = {};
  for (const [k, v] of Object.entries(raw)) m[songKey(k)] = Math.max(m[songKey(k)] || 0, v);
  return m;
}
export function markPlayed(title, kind = "played"){
  const key = kind === "tired" ? LS_TIRED : LS_PLAYED;
  const m = loadMap(key);
  m[songKey(title)] = Date.now();
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  for (const k of Object.keys(m)) if (!(m[k] > cutoff)) delete m[k];
  lsSet(key, m);
}

/* Folds any number of histories ({ played, tired } maps, this phone's, a
   group's, each present person's) into one map of song key -> the time the
   song may come back; the latest wins. buildCrate takes this map. */
export function cooldownOf(...histories){
  const until = {};
  for (const h of histories){
    if (!h) continue;
    for (const kind of ["played", "tired"]){
      const days = COOLDOWN_DAYS[kind];
      for (const [k, at] of Object.entries(h[kind] || {})){
        if (!Number.isFinite(at)) continue;
        const t = at + days*DAY;
        if (!(until[k] >= t)) until[k] = t;
      }
    }
  }
  return until;
}

/* How many of the given histories (one per present person) hold each song. */
export function heardCount(...histories){
  const n = {};
  for (const h of histories){
    if (!h) continue;
    const keys = new Set([...Object.keys(h.played || {}), ...Object.keys(h.tired || {})]);
    for (const k of keys) n[k] = (n[k] || 0) + 1;
  }
  return n;
}

export const normArtist = s => String(s||"").trim().toLowerCase();
export const loadBlocked = () => { const l = lsGet(LS_BLOCKED); return Array.isArray(l) ? l.filter(x=>typeof x==="string" && x.trim()).slice(0,50) : []; };
export const saveBlocked = l => lsSet(LS_BLOCKED, l.slice(0,50));
export const trackArtists = t => String(t.artist||"").split(",").map(normArtist).filter(Boolean);
export const isBlocked = (t, set) => trackArtists(t).some(a=>set.has(a));
