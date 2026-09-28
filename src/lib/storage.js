/* Device-local stores (localStorage), there are no accounts: track
   sanitization, the song history behind the cooldown and the blocked-artist list.
   The saved game itself lives in save.ts. */
import { DIFFICULTIES, SNIP_WINDOW_SEC } from "./constants.js";
import { songKey, safeUrl } from "./utils.js";
import { COOLDOWN_DAYS } from "./config";

const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs }, songs heard through to the reveal
const LS_TIRED = "tt_tired";     // { titleKey: lastSkippedMs }, songs skipped as heard too much
const LS_BLOCKED = "tt_blocked"; // [ artistName ], device-local "never play this artist" list
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

const DAY = 24*3600*1000;
// Kept as long as the longest cooldown; a group import reads the same window.
export const HISTORY_MS = Math.max(...Object.values(COOLDOWN_DAYS)) * DAY;

function loadMap(k){
  const raw = lsGet(k);
  if (Array.isArray(raw)){ // migrate the old list format: treat every entry as just played
    const m = {}; const t = Date.now();
    for (const x of raw) if (typeof x === "string") m[songKey(x)] = t;
    return m;
  }
  if (!raw || typeof raw !== "object") return {};
  // Re-key through songKey: entries written before the key normalization
  // strengthened (e.g. 'song - from "movie"') collapse to the current key.
  const m = {};
  for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) m[songKey(k)] = Math.max(m[songKey(k)] || 0, v);
  return m;
}

/* This device's history: { played: { key: ms }, tired: { key: ms } }. */
export const loadHistory = () => ({ played: loadMap(LS_PLAYED), tired: loadMap(LS_TIRED) });

export function markPlayed(title, kind = "played"){
  const k = kind === "tired" ? LS_TIRED : LS_PLAYED;
  const m = loadMap(k);
  m[songKey(title)] = Date.now();
  const cutoff = Date.now() - HISTORY_MS;
  for (const key of Object.keys(m)) if (!(m[key] > cutoff)) delete m[key];
  lsSet(k, m);
}

/* Histories (this device, a group, ...) to one map of song key -> the time
   the song may come back, each kind sitting out its own COOLDOWN_DAYS. */
export function cooldownOf(...histories){
  const until = {};
  for (const h of histories) for (const kind of Object.keys(COOLDOWN_DAYS)){
    for (const [k, at] of Object.entries(h?.[kind] || {})){
      if (Number.isFinite(at)) until[k] = Math.max(until[k] || 0, at + COOLDOWN_DAYS[kind] * DAY);
    }
  }
  return until;
}

export const normArtist = s => String(s||"").trim().toLowerCase();
export const loadBlocked = () => { const l = lsGet(LS_BLOCKED); return Array.isArray(l) ? l.filter(x=>typeof x==="string" && x.trim()).slice(0,50) : []; };
export const saveBlocked = l => lsSet(LS_BLOCKED, l.slice(0,50));
export const trackArtists = t => String(t.artist||"").split(",").map(normArtist).filter(Boolean);
export const isBlocked = (t, set) => trackArtists(t).some(a=>set.has(a));
