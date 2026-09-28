/* Device-local stores (localStorage), there are no accounts: track
   sanitization, the recent-play cooldown and the blocked-artist list.
   The saved game itself lives in save.ts. */
import { DIFFICULTIES, SNIP_WINDOW_SEC, snipMethodOk } from "./constants.js";
import { songKey, safeUrl } from "./utils.js";

const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs } — device-local recent-play cooldown
const LS_BLOCKED = "tt_blocked"; // [ artistName ] — device-local "never play this artist" list
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
    ...(t.snip && t.sourceId === t.snip.sourceId && snipMethodOk(t.snip.method) && typeof t.snip.indexBuilt === "string" &&
      Number.isFinite(t.snip.startSec) && Number.isFinite(t.snip.endSec) &&
      t.snip.startSec >= 0 && t.snip.endSec - t.snip.startSec === SNIP_WINDOW_SEC
      ? { snip: { startSec:t.snip.startSec, endSec:t.snip.endSec, sourceId:t.sourceId, method:t.snip.method, indexBuilt:t.snip.indexBuilt } } : {}),
    ...(t.music ? { music: String(t.music).slice(0,120) } : {}),
  };
}

export const PLAY_COOLDOWN = 7*24*3600*1000; // a song heard on this device sits out for a week
export function loadPlayed(){
  const raw = lsGet(LS_PLAYED);
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
export function markPlayed(title){
  const m = loadPlayed();
  m[songKey(title)] = Date.now();
  const cutoff = Date.now() - 30*24*3600*1000;
  for (const k of Object.keys(m)) if (!(m[k] > cutoff)) delete m[k];
  lsSet(LS_PLAYED, m);
}

export const normArtist = s => String(s||"").trim().toLowerCase();
export const loadBlocked = () => { const l = lsGet(LS_BLOCKED); return Array.isArray(l) ? l.filter(x=>typeof x==="string" && x.trim()).slice(0,50) : []; };
export const saveBlocked = l => lsSet(LS_BLOCKED, l.slice(0,50));
export const trackArtists = t => String(t.artist||"").split(",").map(normArtist).filter(Boolean);
export const isBlocked = (t, set) => trackArtists(t).some(a=>set.has(a));
