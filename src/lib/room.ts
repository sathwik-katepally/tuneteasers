/* Buzz-in room client: making a room, the room link, the WebSocket to the
   room's Durable Object (worker/src/room.js, protocol in docs/room-mode.md),
   the two things a device remembers so a reload or a dropped connection
   lands back in the same seat (a phone's seat key, the host's show), and the
   song history a phone brings to its seat so the host leaves those songs out. */
import { useEffect, useRef, useState } from "react";
import { usePartySocket } from "partysocket/react";
import { ROOM_HEARD, WORKER_API } from "./constants.js";
import { cooldownOf, loadHistory, markPlayed, sanitizeTrack } from "./storage.js";
import { songKey } from "./utils.js";
import { randomId } from "./group";
import type { Category, Difficulty, Mix, Track } from "../types";

export const ROOM_ORIGIN = String(WORKER_API).replace(/\/api$/, "");
const CODE_RX = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const LS_SEAT = "tt_room_seat";
const LS_HOST = "tt_room_host";
const LS_NAME = "tt_room_name";

export type SongState = "cue" | "live" | "answering" | "missed" | "revealed" | "skipped";
export interface RoomPlayer { id: string; name: string; score: number; online: boolean }
export interface Guess { id: string; text: string; ok: boolean; timeout: boolean }
export interface RoomAnswer { title: string; film: string; year: number; artist: string }
export interface RoomSong {
  n: number;
  /* This cue of song n; a re-cue after a skip gets a new one. */
  cue: number;
  rung: number;
  points: number;
  state: SongState;
  queue: string[];
  locked: string[];
  answering: string | null;
  msLeft: number | null;
  guesses: Guess[];
  winner: string | null;
  won: number;
  answer: RoomAnswer | null;
  /* Seats that voted "Heard it" for this song, and how many votes skip it. */
  votes: string[];
  votesNeeded: number;
}
export interface RoomResult { n: number; title: string; winner: string | null; points: number }
/* A song skipped this show, by its song key; tired when this phone voted for the skip. */
export interface RoomSkipped { key: string; tired: boolean }
export interface RoomView {
  phase: "lobby" | "show" | "over";
  code: string;
  mix: Mix;
  total: number;
  perRound: number;
  answerSecs: number;
  players: RoomPlayer[];
  results: RoomResult[];
  skipped: RoomSkipped[];
  seq: number;
  /* "Heard it too much" skips this show, and the room's cap. */
  skips: { used: number; max: number };
  song: RoomSong | null;
  me: string | null;
  // Local clock time the view arrived, so a countdown can run from msLeft.
  at: number;
}

export const cleanCode = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
export const isCode = (v: string) => CODE_RX.test(v);
export const roomLink = (code: string) => `${location.origin}${location.pathname}#room=${code}`;

/* A room link is #room=CODE. It stays in the address bar while the phone is
   in the room, so a reload goes straight back to the seat. */
export function roomFromUrl(): string {
  if (!location.hash.startsWith("#room=")) return "";
  const code = cleanCode(location.hash.slice("#room=".length));
  return isCode(code) ? code : "";
}
export function setRoomUrl(code: string){
  const want = code ? `#room=${code}` : "";
  if (location.hash !== want) history.replaceState(null, "", location.pathname + location.search + want);
}

const lsGet = (k: string): unknown => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch {} };

export interface Seat { code: string; key: string }
export function loadSeat(code: string): Seat | null {
  const s = lsGet(LS_SEAT) as Seat | null;
  return s && s.code === code && typeof s.key === "string" ? s : null;
}
export function newSeat(code: string): Seat {
  const seat = { code, key: randomId() + randomId() };
  lsSet(LS_SEAT, seat);
  return seat;
}
export const dropSeat = () => lsDel(LS_SEAT);
export const lastName = () => { const n = lsGet(LS_NAME); return typeof n === "string" ? n : ""; };
export const rememberName = (n: string) => lsSet(LS_NAME, n);

/* The host's show: enough to pick it back up after a reload. Scores live in
   the room, so they are not here. */
export interface HostShow {
  code: string;
  host: string;
  queue: Track[];
  idx: number;
  songNo: number;
  total: number;
  perRound: number;
  plain: boolean;
  difficulty: Difficulty;
  mix: Mix;
  eras: string[];
  categories: Category[];
  started: boolean;
  /* The room's skip count this screen has already acted on, so a skip is
     swapped for a new song exactly once, across reloads too. */
  skipsSeen: number;
}
export function loadHostShow(): HostShow | null {
  const s = lsGet(LS_HOST) as HostShow | null;
  if (!s || !isCode(s.code) || typeof s.host !== "string" || !Array.isArray(s.queue)) return null;
  const queue = s.queue.map(t => sanitizeTrack(t)).filter(Boolean) as Track[];
  return { ...s, queue, categories: Array.isArray(s.categories) ? s.categories : [], skipsSeen: Number.isInteger(s.skipsSeen) ? s.skipsSeen : 0 };
}
export const saveHostShow = (s: HostShow | null) => (s ? lsSet(LS_HOST, s) : lsDel(LS_HOST));

/* What a phone brings to its seat: the songs it is still sitting out, as
   song key -> hours until it may come back (hours, not a time, so the
   phone's and the host's clocks never need to agree). */
export function heardPayload(): Record<string, number> {
  const now = Date.now();
  return Object.fromEntries(Object.entries(cooldownOf(loadHistory()) as Record<string, number>)
    .filter(([k, at]) => at > now && k.length <= ROOM_HEARD.key)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ROOM_HEARD.songs)
    .map(([k, at]) => [k, Math.min(ROOM_HEARD.hours, Math.ceil((at - now) / 3600e3))]));
}

/* The seated phones' songs as the room sends them to the host
   ({ key: [hours, seats] }), merged into the host's own cooldown map. The
   host's own history counts as one more person for the order of repeats. */
export type RoomHeard = Record<string, [number, number]>;
export function withRoomHeard(own: Record<string, number>, heard: RoomHeard | null){
  const now = Date.now();
  const cooldown = { ...own };
  const heardBy: Record<string, number> = {};
  for (const [k, at] of Object.entries(own)) if (at > now) heardBy[k] = 1;
  for (const [k, [hours, seats]] of Object.entries(heard || {})){
    cooldown[k] = Math.max(cooldown[k] || 0, now + hours * 3600e3);
    heardBy[k] = (heardBy[k] || 0) + seats;
  }
  return { cooldown, heardBy };
}

/* A phone keeps what it heard in the room in its own history, so the next
   room (or pass-the-phone game) leaves it out: every revealed song as
   played, a skipped one as tired when this phone voted for the skip. Once
   per page load, song and kind is enough (recording again only moves the
   time), but per kind: a song skipped as played in one show and voted out
   in a later one must still become tired. */
export function useRecordHeard(view: RoomView | null){
  const done = useRef(new Set<string>());
  useEffect(() => {
    if (!view) return;
    const record = (title: string, kind: "played" | "tired") => {
      const id = `${kind}:${songKey(title)}`;
      if (done.current.has(id)) return;
      done.current.add(id);
      markPlayed(title, kind);
    };
    for (const r of view.results) record(r.title, "played");
    for (const x of view.skipped || []) record(x.key, x.tired ? "tired" : "played");
  }, [view?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
}

export async function createRoom(): Promise<{ code: string; host: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${ROOM_ORIGIN}/api/rooms`, { method: "POST", signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !isCode(j.code) || typeof j.host !== "string") throw new Error(j?.message || `room ${r.status}`);
    return { code: j.code, host: j.host };
  } finally { clearTimeout(timer); }
}

export type Link = "connecting" | "open" | "retrying" | "gone";
// Close codes from the room that mean "stop trying": no such room, not the
// host / removed by the host, room expired.
const FINAL = new Set([4404, 4403, 4410]);

/* One live connection to a room. `hello` is sent on every (re)connect, which
   is how a dropped phone gets its seat back; a function is called each time. */
export function useRoom(code: string, hello: object | (() => object) | null){
  const [view, setView] = useState<RoomView | null>(null);
  const [heard, setHeard] = useState<RoomHeard | null>(null);
  const [link, setLink] = useState<Link>("connecting");
  const [error, setError] = useState<{ code: string; at: number } | null>(null);
  const [gone, setGone] = useState<{ code: number; kicked: boolean } | null>(null);
  const helloRef = useRef(hello);
  helloRef.current = hello;
  const kicked = useRef(false);

  const socket = usePartySocket({
    host: ROOM_ORIGIN.replace(/^https?:\/\//, ""),
    party: "room",
    room: code,
    enabled: !!code && !!hello,
    maxEnqueuedMessages: 0,
    minReconnectionDelay: 400,
    maxReconnectionDelay: 4000,
    shouldReconnectOnClose: e => !FINAL.has(e.code),
    onOpen(){
      setLink("open");
      const h = helloRef.current;
      if (h) socket.send(JSON.stringify(typeof h === "function" ? h() : h));
    },
    onMessage(e){
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === "state") setView({ ...m, at: Date.now() });
      else if (m.t === "heard" && m.songs && typeof m.songs === "object") setHeard(m.songs);
      else if (m.t === "error") setError({ code: String(m.code), at: Date.now() });
      else if (m.t === "kicked") kicked.current = true;
    },
    onClose(e){
      if (FINAL.has(e.code)){
        setGone({ code: e.code, kicked: kicked.current });
        setLink("gone");
      } else setLink(l => (l === "gone" ? l : "retrying"));
    },
  });

  useEffect(() => { setView(null); setHeard(null); setGone(null); setError(null); setLink("connecting"); kicked.current = false; }, [code]);

  /* iOS suspends a page in the background, which is where a host goes to send
     the code, and can drop its socket without a close: it still looks open but
     nothing arrives, so the lobby never shows who joined meanwhile. Coming back
     reconnects, and the hello brings the whole view again. */
  const live = !!code && !!hello && !gone;
  useEffect(() => {
    if (!live) return;
    let hiddenAt = 0;
    const vis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 2000){ hiddenAt = 0; socket.reconnect(); }
    };
    const show = (e: PageTransitionEvent) => { if (e.persisted) socket.reconnect(); };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("pageshow", show);
    return () => { document.removeEventListener("visibilitychange", vis); window.removeEventListener("pageshow", show); };
  }, [live, socket]);

  const send = (m: object) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(m));
    return true;
  };
  const leave = () => socket.close();
  return { view, heard, link, error, gone, send, leave };
}

/* Milliseconds left on the answer clock, ticking locally from the last view. */
export function useMsLeft(view: RoomView | null){
  const [now, setNow] = useState(Date.now);
  const live = view?.song?.msLeft != null;
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [live]);
  if (!view?.song || view.song.msLeft == null) return null;
  return Math.max(0, view.song.msLeft - (now - view.at));
}

export const playerName = (view: RoomView | null, id: string | null) => (id && view?.players.find(p => p.id === id)?.name) || "";
