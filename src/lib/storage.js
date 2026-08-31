/* Persistence: auto-save on every change, auto-resume on load.
   Everything is device-local (localStorage) — there are no accounts. */
import { ERAS } from "./constants.js";
import { songKey, safeUrl } from "./utils.js";

const LS_KEY = "tuneteasers_v6";
const LS_PLAYED = "tt_played";   // { titleKey: lastPlayedMs } — device-local recent-play cooldown
const LS_BLOCKED = "tt_blocked"; // [ artistName ] — device-local "never play this artist" list
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } };
const lsSet = (k,v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} };

export const DEFAULTS = {
  screen: "setup",
  settings: { mix:"both", sound:"inst", snippetLen:10, eras:[...ERAS] },
  players: [{name:"Player 1",score:0},{name:"Player 2",score:0}],
  game: null, // { queue, trackIdx, turn, round, totalSongs, source }
};

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
    // verified instrumental-window start (seconds), when the snips index vouched for it
    ...(Number.isFinite(t.snip) ? { snip: Math.max(0, Math.floor(t.snip)) } : {}),
  };
}

export function loadPersisted(){
  const raw = lsGet(LS_KEY);
  if (!raw) return DEFAULTS;
  const s = { ...DEFAULTS };
  const set = raw.settings || {};
  const eras = Array.isArray(set.eras) ? ERAS.filter(e=>set.eras.includes(e)) : [];
  s.settings = {
    mix: ["bolly","telugu","both"].includes(set.mix) ? set.mix : "both",
    sound: ["inst","full"].includes(set.sound) ? set.sound : "inst",
    snippetLen: [5,10,15].includes(set.snippetLen) ? set.snippetLen : 10,
    eras: eras.length ? eras : [...ERAS],
  };
  if (Array.isArray(raw.players) && raw.players.length)
    s.players = raw.players.slice(0,8).map(p=>({ name:String(p.name||"Player").slice(0,24), score:Math.max(0, Math.round((parseFloat(p.score)||0)*2)/2) }));
  if (raw.game && Array.isArray(raw.game.queue)){
    const queue = raw.game.queue.map(sanitizeTrack).filter(Boolean);
    const trackIdx = Math.max(0, parseInt(raw.game.trackIdx)||0);
    if (queue.length && trackIdx < queue.length){
      s.game = {
        queue, trackIdx,
        turn: Math.min(Math.max(0, parseInt(raw.game.turn)||0), s.players.length-1),
        round: Math.max(1, parseInt(raw.game.round)||1),
        totalSongs: queue.length,
        source: ["saavn","catalog","live"].includes(raw.game.source) ? raw.game.source : "catalog",
      };
      // Screen stays "setup": the home page offers a Resume card instead of jumping straight in.
    }
  }
  return s;
}
export const persist = s => lsSet(LS_KEY, { settings:s.settings, players:s.players, game:s.game });

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
