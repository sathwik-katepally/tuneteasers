/* Device-local stores (localStorage), there are no accounts: track
   sanitization, the song history behind the cooldown and the blocked-artist list.
   The saved game itself lives in save.ts. */
import { SNIP_WINDOW_SEC, snipMethodOk } from "./constants.js";
import { songKey, safeUrl } from "./utils.js";
import { COOLDOWN_DAYS } from "./config";
import type { Track } from "../types";

const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs }, songs heard through to the reveal
const LS_BLOCKED = "tt_blocked"; // [ artistName ], device-local "never play this artist" list
const lsGet = (k: string): unknown => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch(e){ return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

/* Whatever a save, a catalog row or a song source hands over; every field is
   checked here before it becomes a Track. */
export function sanitizeTrack(raw: unknown): Track | null {
  const t: Record<string, any> = raw && typeof raw === "object" ? raw : {};
  const stream = safeUrl(t.stream); if (!stream) return null;
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
    ...(typeof t.sourceId === "string" && t.sourceId ? { sourceId: t.sourceId } : {}),
    ...(Number.isFinite(parseFloat(t.score)) ? { score: Math.min(1, Math.max(0, parseFloat(t.score))) } : {}),
    ...(t.snip && t.sourceId === t.snip.sourceId && snipMethodOk(t.snip.method) && typeof t.snip.indexBuilt === "string" &&
      Number.isFinite(t.snip.startSec) && Number.isFinite(t.snip.endSec) &&
      t.snip.startSec >= 0 && t.snip.endSec - t.snip.startSec === SNIP_WINDOW_SEC
      ? { snip: { startSec:t.snip.startSec, endSec:t.snip.endSec, sourceId:t.sourceId, method:t.snip.method, indexBuilt:t.snip.indexBuilt } } : {}),
    ...(t.music ? { music: String(t.music).slice(0,120) } : {}),
  };
}

const DAY = 24*3600*1000;
// Kept as long as the cooldown; a group import reads the same window.
export const HISTORY_MS = COOLDOWN_DAYS * DAY;

/* Song key -> when the song last played through to the reveal (ms). */
export type History = Record<string, number>;
/* Song key -> the time the song may come back (ms). */
export type Cooldown = Record<string, number>;

/* This device's history. */
export function loadHistory(): History {
  const raw = lsGet(LS_PLAYED);
  if (Array.isArray(raw)){ // migrate the old list format: treat every entry as just played
    const m: History = {}; const t = Date.now();
    for (const x of raw) if (typeof x === "string") m[songKey(x)] = t;
    return m;
  }
  if (!raw || typeof raw !== "object") return {};
  // Re-key through songKey: entries written before the key normalization
  // strengthened (e.g. 'song - from "movie"') collapse to the current key.
  const m: History = {};
  for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) m[songKey(k)] = Math.max(m[songKey(k)] || 0, v);
  return m;
}

export function markPlayed(title: string){
  const m = loadHistory();
  m[songKey(title)] = Date.now();
  const cutoff = Date.now() - HISTORY_MS;
  for (const key of Object.keys(m)) if (!(m[key] > cutoff)) delete m[key];
  lsSet(LS_PLAYED, m);
}

/* Histories (this device, a group, ...) to one map of song key -> the time
   the song may come back, COOLDOWN_DAYS after it last played, latest wins. */
export function cooldownOf(...histories: (History | null)[]): Cooldown {
  const until: Cooldown = {};
  for (const h of histories) for (const [k, at] of Object.entries(h || {})){
    if (Number.isFinite(at)) until[k] = Math.max(until[k] || 0, at + COOLDOWN_DAYS * DAY);
  }
  return until;
}

export const normArtist = (s: string) => String(s||"").trim().toLowerCase();
export const loadBlocked = (): string[] => { const l = lsGet(LS_BLOCKED); return Array.isArray(l) ? l.filter(x=>typeof x==="string" && x.trim()).slice(0,50) : []; };
export const saveBlocked = (l: string[]) => lsSet(LS_BLOCKED, l.slice(0,50));
const trackArtists = (t: Pick<Track, "artist">) => String(t.artist||"").split(",").map(normArtist).filter(Boolean);
export const isBlocked = (t: Pick<Track, "artist">, set: Set<string>) => trackArtists(t).some(a=>set.has(a));
