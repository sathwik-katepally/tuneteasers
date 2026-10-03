/* Device-local stores (localStorage), there are no accounts: track
   sanitization, the song history behind the cooldown and the blocked-artist list.
   The saved game itself lives in save.ts. */
import { DIFFICULTIES, SNIP_WINDOW_SEC, snipMethodOk } from "./constants.js";
import { songKey, safeUrl } from "./utils.js";
import { COOLDOWN_DAYS } from "./config";
import type { PlayKind, Track } from "../types";

const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs }, songs heard through to the reveal
const LS_TIRED = "tt_tired";     // { titleKey: lastSkippedMs }, songs skipped as heard too much
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
    ...(DIFFICULTIES.includes(t.tier) && t.tier !== "mixed" ? { tier: t.tier } : {}),
    ...(typeof t.sourceId === "string" && t.sourceId ? { sourceId: t.sourceId } : {}),
    ...(t.snip && t.sourceId === t.snip.sourceId && snipMethodOk(t.snip.method) && typeof t.snip.indexBuilt === "string" &&
      Number.isFinite(t.snip.startSec) && Number.isFinite(t.snip.endSec) &&
      t.snip.startSec >= 0 && t.snip.endSec - t.snip.startSec === SNIP_WINDOW_SEC
      ? { snip: { startSec:t.snip.startSec, endSec:t.snip.endSec, sourceId:t.sourceId, method:t.snip.method, indexBuilt:t.snip.indexBuilt } } : {}),
    ...(t.music ? { music: String(t.music).slice(0,120) } : {}),
  };
}

const DAY = 24*3600*1000;
// Kept as long as the longest cooldown; a group import reads the same window.
export const HISTORY_MS = Math.max(...Object.values(COOLDOWN_DAYS)) * DAY;

/* Song key -> when the song last left the stage (ms), one map per kind. */
export type HistoryMap = Record<string, number>;
export type History = Record<PlayKind, HistoryMap>;
/* Song key -> the time the song may come back (ms). */
export type Cooldown = Record<string, number>;

function loadMap(k: string): HistoryMap {
  const raw = lsGet(k);
  if (Array.isArray(raw)){ // migrate the old list format: treat every entry as just played
    const m: HistoryMap = {}; const t = Date.now();
    for (const x of raw) if (typeof x === "string") m[songKey(x)] = t;
    return m;
  }
  if (!raw || typeof raw !== "object") return {};
  // Re-key through songKey: entries written before the key normalization
  // strengthened (e.g. 'song - from "movie"') collapse to the current key.
  const m: HistoryMap = {};
  for (const [k, v] of Object.entries(raw)) if (Number.isFinite(v)) m[songKey(k)] = Math.max(m[songKey(k)] || 0, v);
  return m;
}

/* This device's history: { played: { key: ms }, tired: { key: ms } }. */
export const loadHistory = (): History => ({ played: loadMap(LS_PLAYED), tired: loadMap(LS_TIRED) });

export function markPlayed(title: string, kind: PlayKind = "played"){
  const k = kind === "tired" ? LS_TIRED : LS_PLAYED;
  const m = loadMap(k);
  m[songKey(title)] = Date.now();
  const cutoff = Date.now() - HISTORY_MS;
  for (const key of Object.keys(m)) if (!(m[key] > cutoff)) delete m[key];
  lsSet(k, m);
}

/* Histories (this device, a group, ...) to one map of song key -> the time
   the song may come back, each kind sitting out its own COOLDOWN_DAYS. */
export function cooldownOf(...histories: (History | null)[]): Cooldown {
  const until: Cooldown = {};
  for (const h of histories) for (const kind of Object.keys(COOLDOWN_DAYS) as PlayKind[]){
    for (const [k, at] of Object.entries(h?.[kind] || {})){
      if (Number.isFinite(at)) until[k] = Math.max(until[k] || 0, at + COOLDOWN_DAYS[kind] * DAY);
    }
  }
  return until;
}

export const normArtist = (s: string) => String(s||"").trim().toLowerCase();
export const loadBlocked = (): string[] => { const l = lsGet(LS_BLOCKED); return Array.isArray(l) ? l.filter(x=>typeof x==="string" && x.trim()).slice(0,50) : []; };
export const saveBlocked = (l: string[]) => lsSet(LS_BLOCKED, l.slice(0,50));
export const trackArtists = (t: Pick<Track, "artist">) => String(t.artist||"").split(",").map(normArtist).filter(Boolean);
export const isBlocked = (t: Pick<Track, "artist">, set: Set<string>) => trackArtists(t).some(a=>set.has(a));
