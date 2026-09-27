/* Buzz-in room client: making a room, the room link, the WebSocket to the
   room's Durable Object (worker/src/room.js, protocol in docs/room-mode.md),
   and the two things a device remembers so a reload or a dropped connection
   lands back in the same seat: a phone's seat key, the host's show. */
import { useEffect, useRef, useState } from "react";
import { usePartySocket } from "partysocket/react";
import { WORKER_API } from "./constants.js";
import { sanitizeTrack } from "./storage.js";
import { randomId } from "./group";
import type { Category, Difficulty, Mix, Track } from "../types";

export const ROOM_ORIGIN = String(WORKER_API).replace(/\/api$/, "");
const CODE_RX = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const LS_SEAT = "tt_room_seat";
const LS_HOST = "tt_room_host";
const LS_NAME = "tt_room_name";

export type SongState = "cue" | "live" | "answering" | "missed" | "revealed";
export interface RoomPlayer { id: string; name: string; score: number; online: boolean }
export interface Guess { id: string; text: string; ok: boolean; timeout: boolean }
export interface RoomAnswer { title: string; film: string; year: number; artist: string }
export interface RoomSong {
  n: number;
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
}
export interface RoomResult { n: number; title: string; winner: string | null; points: number }
export interface RoomView {
  phase: "lobby" | "show" | "over";
  code: string;
  total: number;
  perRound: number;
  answerSecs: number;
  players: RoomPlayer[];
  results: RoomResult[];
  seq: number;
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
}
export function loadHostShow(): HostShow | null {
  const s = lsGet(LS_HOST) as HostShow | null;
  if (!s || !isCode(s.code) || typeof s.host !== "string" || !Array.isArray(s.queue)) return null;
  const queue = s.queue.map(t => sanitizeTrack(t)).filter(Boolean) as Track[];
  return { ...s, queue, categories: Array.isArray(s.categories) ? s.categories : [] };
}
export const saveHostShow = (s: HostShow | null) => (s ? lsSet(LS_HOST, s) : lsDel(LS_HOST));

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
   is how a dropped phone gets its seat back. */
export function useRoom(code: string, hello: object | null){
  const [view, setView] = useState<RoomView | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
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
      if (helloRef.current) socket.send(JSON.stringify(helloRef.current));
    },
    onMessage(e){
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === "state") setView({ ...m, at: Date.now() });
      else if (m.t === "titles" && Array.isArray(m.titles)) setTitles(m.titles.filter((x: unknown) => typeof x === "string"));
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

  useEffect(() => { setView(null); setTitles([]); setGone(null); setError(null); setLink("connecting"); kicked.current = false; }, [code]);

  const send = (m: object) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(m));
    return true;
  };
  const leave = () => socket.close();
  return { view, titles, link, error, gone, send, leave };
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
