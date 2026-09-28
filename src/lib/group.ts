/* Group sync client. A group is a shared invite between phones; joining one
   makes every phone skip songs any of them played recently and keeps the
   group's finished shows. Everything here is optional: with no group, or with
   the Worker unreachable, the game runs on this phone's own history.
   Writes go through a localStorage outbox first, so a play or a finished show
   made offline (or right before a reload) is sent on the next flush. */
import { useSyncExternalStore } from "react";
import { WORKER_API } from "./constants.js";
import { songKey } from "./utils.js";
import { HISTORY_MS, cooldownOf, loadHistory } from "./storage.js";
import type { GameState, PlayKind } from "../types";

export interface Group {
  id: string;
  name: string;
  invite: string;
  owner?: string;
}

export interface ResultCast {
  name: string;
  score: number;
  members: string[];
}

export interface GroupResult {
  id: string;
  finishedAt: number;
  mode: "players" | "teams";
  difficulty: "easy" | "medium" | "hard";
  mix: "bolly" | "telugu" | "both";
  rounds: number;
  songs: number;
  cast: ResultCast[];
}

type Round = { id: string; key: string; kind?: PlayKind };
export interface History { played: Record<string, number>; tired: Record<string, number> }
interface Outbox { groupId: string; rounds: Round[]; results: GroupResult[] }
export type SyncState = "idle" | "syncing" | "offline" | "revoked";
export interface GroupSnapshot { group: Group | null; pending: number; sync: SyncState }

const LS_GROUP = "tt_group";
const LS_OUTBOX = "tt_group_outbox";
const TIMEOUT_MS = 5000;
const ROUND_BATCH = 50;
const OUTBOX_MAX = 500;
const IMPORT_MAX = 1000;
export const GROUP_NAME_MAX = 32;

const INVITE_RX = /([a-z2-7]{12}\.[A-Za-z0-9_-]{22})/;
const ID_RX = /^[A-Za-z0-9_-]{8,40}$/;

const lsGet = (k: string): unknown => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch {} };

export function randomId(){
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}
export const isResultId = (v: unknown): v is string => typeof v === "string" && ID_RX.test(v);

export function parseInvite(text: string): string {
  const m = INVITE_RX.exec(String(text || "").trim());
  return m ? m[1] : "";
}
export const inviteLink = (invite: string) => `${location.origin}${location.pathname}#join=${invite}`;

export const BROKEN_INVITE = "broken";

/* An invite arrives as #join=<invite> so it never reaches a server log.
   It is removed from the address bar straight away. Invites are URL-safe, so
   the fragment is matched as is: decoding a mangled link (#join=%) throws. */
export function takeInviteFromUrl(): string {
  if (!location.hash.startsWith("#join=")) return "";
  const invite = parseInvite(location.hash.slice("#join=".length));
  history.replaceState(null, "", location.pathname + location.search);
  return invite || BROKEN_INVITE;
}

function readGroup(): Group | null {
  const g = lsGet(LS_GROUP) as Partial<Group> | null;
  if (!g || typeof g !== "object" || typeof g.invite !== "string" || !parseInvite(g.invite)) return null;
  const owner = typeof g.owner === "string" && parseInvite(g.owner) ? g.owner : undefined;
  return { id: g.invite.split(".")[0], name: String(g.name || "Our group").slice(0, GROUP_NAME_MAX), invite: g.invite, ...(owner ? { owner } : {}) };
}

function readOutbox(groupId: string): Outbox {
  const o = lsGet(LS_OUTBOX) as Partial<Outbox> | null;
  if (!o || o.groupId !== groupId) return { groupId, rounds: [], results: [] };
  return {
    groupId,
    rounds: Array.isArray(o.rounds) ? o.rounds.filter(r => r && isResultId(r.id) && typeof r.key === "string") : [],
    results: Array.isArray(o.results) ? o.results.filter(r => r && isResultId(r.id)) : [],
  };
}
const pendingOf = (o: Outbox) => o.rounds.length + o.results.length;

let snap: GroupSnapshot = (() => {
  const group = readGroup();
  return { group, pending: group ? pendingOf(readOutbox(group.id)) : 0, sync: "idle" };
})();
const listeners = new Set<() => void>();
function emit(patch: Partial<GroupSnapshot>){
  snap = { ...snap, ...patch };
  listeners.forEach(l => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useGroup = () => useSyncExternalStore(subscribe, () => snap);
export const currentGroup = () => snap.group;

export class GroupError extends Error {
  constructor(public status: number, message: string){ super(message); }
}

async function call<T>(path: string, token: string | null, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(WORKER_API + path, {
      method: init.method || (init.body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: ctl.signal,
    });
  } catch {
    throw new GroupError(0, "Couldn't reach the group. Check the connection.");
  } finally {
    clearTimeout(timer);
  }
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new GroupError(r.status, body?.message || `The group server answered ${r.status}.`);
  return body as T;
}

const deviceHistory = () => loadHistory() as History;

/* The newest IMPORT_MAX songs of this phone's history, across both kinds. */
function localHistory(): History {
  const since = Date.now() - HISTORY_MS;
  const h = deviceHistory();
  const entries = (["played", "tired"] as const).flatMap(kind => Object.entries(h[kind]).map(([k, v]) => ({ kind, k, v })))
    .filter(e => e.k && e.v > since)
    .sort((a, b) => b.v - a.v)
    .slice(0, IMPORT_MAX);
  const out: History = { played: {}, tired: {} };
  for (const e of entries) out[e.kind][e.k] = e.v;
  return out;
}
export const localHistoryCount = () => { const h = localHistory(); return new Set([...Object.keys(h.played), ...Object.keys(h.tired)]).size; };

function adopt(group: Group){
  lsSet(LS_GROUP, group);
  lsDel(LS_OUTBOX);
  emit({ group, pending: 0, sync: "idle" });
}

async function importHistory(invite: string){
  const { played, tired } = localHistory();
  if (Object.keys(played).length || Object.keys(tired).length) await call("/group/import", invite, { body: { played, tired } });
}

export async function createGroup(name: string, withHistory: boolean){
  const r = await call<{ group: { id: string; name: string }; invite: string; owner: string }>("/groups", null, { body: { name } });
  adopt({ id: r.group.id, name: r.group.name, invite: r.invite, owner: r.owner });
  if (withHistory) await importHistory(r.invite).catch(() => {});
}

export async function previewInvite(invite: string){
  const r = await call<{ group: { name: string } }>("/group", invite);
  return r.group.name;
}

export async function joinGroup(invite: string, withHistory: boolean){
  const r = await call<{ group: { id: string; name: string } }>("/group", invite);
  const keepOwner = snap.group?.id === r.group.id ? snap.group.owner : undefined;
  adopt({ id: r.group.id, name: r.group.name, invite, ...(keepOwner ? { owner: keepOwner } : {}) });
  if (withHistory) await importHistory(invite).catch(() => {});
}

export function leaveGroup(){
  lsDel(LS_GROUP);
  lsDel(LS_OUTBOX);
  emit({ group: null, pending: 0, sync: "idle" });
}

export async function deleteGroup(){
  const g = snap.group;
  if (!g?.owner) throw new GroupError(403, "Only the phone that made the group can delete it.");
  await call("/group", g.owner, { method: "DELETE" });
  leaveGroup();
}

function enqueue(add: (o: Outbox) => void){
  const g = snap.group;
  if (!g) return;
  const o = readOutbox(g.id);
  add(o);
  o.rounds = o.rounds.slice(-OUTBOX_MAX);
  o.results = o.results.slice(-OUTBOX_MAX);
  lsSet(LS_OUTBOX, o);
  emit({ pending: pendingOf(o) });
  void flush();
}

export function recordPlay(title: string, kind: PlayKind = "played"){
  const key = songKey(title);
  if (key) enqueue(o => { o.rounds.push({ id: randomId(), key, kind }); });
}

export function recordResult(g: GameState){
  if (!g.history.length) return;
  const result: GroupResult = {
    id: g.id, finishedAt: Date.now(), mode: g.mode, difficulty: g.difficulty, mix: g.mix,
    rounds: g.totalRounds, songs: g.history.length,
    cast: g.cast.map(c => ({ name: c.name, score: c.score, members: c.members })),
  };
  enqueue(o => { if (!o.results.some(r => r.id === result.id)) o.results.push(result); });
}

type FlushResult = "sent" | "failed" | "nothing";
let flushing: Promise<FlushResult> | null = null;

/* Sends the outbox. A network failure or a busy server keeps entries for the
   next try; a rejected entry (400/413) is dropped so it cannot block the rest.
   If the phone switched groups while a flush for the old one was in flight,
   the new group's queue is flushed as soon as that one settles. */
export function flush(): Promise<FlushResult> {
  if (!flushing){
    const groupId = snap.group?.id;
    flushing = doFlush().finally(() => { flushing = null; });
    flushing.then(() => { if (snap.group && snap.group.id !== groupId && snap.pending) void flush(); });
  }
  return flushing;
}

async function doFlush(): Promise<FlushResult> {
  const g = snap.group;
  if (!g || snap.sync === "revoked") return "nothing";
  // The outbox holds one group's queue; a late answer for an old group must not rewrite it.
  const drop = (ids: Set<string>) => {
    if (snap.group?.id !== g.id) return;
    const o = readOutbox(g.id);
    o.rounds = o.rounds.filter(r => !ids.has(r.id));
    o.results = o.results.filter(r => !ids.has(r.id));
    lsSet(LS_OUTBOX, o);
    emit({ pending: pendingOf(o) });
  };
  if (!pendingOf(readOutbox(g.id))) return "nothing";
  emit({ sync: "syncing" });
  try {
    // Plays recorded while a request is in flight are picked up by the next pass.
    for (let o = readOutbox(g.id); pendingOf(o) && snap.group?.id === g.id; o = readOutbox(g.id)){
      if (o.rounds.length){
        const batch = o.rounds.slice(0, ROUND_BATCH);
        await send(() => call("/group/rounds", g.invite, { body: { rounds: batch } }), () => drop(new Set(batch.map(r => r.id))));
      } else {
        const result = o.results[0];
        await send(() => call("/group/results", g.invite, { body: result }), () => drop(new Set([result.id])));
      }
    }
    if (snap.group?.id === g.id) emit({ sync: "idle" });
    return "sent";
  } catch (e){
    if (snap.group?.id === g.id){
      const status = e instanceof GroupError ? e.status : 0;
      emit({ sync: status === 401 || status === 403 ? "revoked" : "offline" });
    }
    return "failed";
  }
}

async function send(request: () => Promise<unknown>, done: () => void){
  try {
    await request();
    done();
  } catch (e){
    if (e instanceof GroupError && (e.status === 400 || e.status === 413)){ done(); return; }
    throw e;
  }
}

/* The group's history. Returns null with no group or when the group can't be
   reached in time, and the crate then falls back to this phone's history alone. */
export async function groupHistory(): Promise<History | null> {
  const g = snap.group;
  if (!g) return null;
  // Only this call's flush says the Worker is down; an "offline" left by an
  // earlier failure must not stop this read, or the group is never asked again.
  if ((await flush()) === "failed" || snap.sync === "revoked") return null;
  try {
    const r = await call<Partial<History>>("/group/played", g.invite);
    if (snap.group?.id === g.id && snap.sync !== "syncing") emit({ sync: "idle" });
    return { played: r.played || {}, tired: r.tired || {} };
  } catch (e){
    if (snap.group?.id === g.id){
      const status = e instanceof GroupError ? e.status : 0;
      emit({ sync: status === 401 || status === 403 ? "revoked" : "offline" });
    }
    return null;
  }
}

/* The cooldown for a new crate: this phone's history merged with the
   group's, or null when there is no group or it can't be reached. */
export async function groupCooldown(): Promise<Record<string, number> | null> {
  const h = await groupHistory();
  return h && (cooldownOf(deviceHistory(), h) as Record<string, number>);
}

export async function fetchResults(before?: number){
  const g = snap.group;
  if (!g) return { results: [], more: false };
  const q = before ? `?before=${before}` : "";
  try {
    return await call<{ results: GroupResult[]; more: boolean }>(`/group/results${q}`, g.invite);
  } catch (e){
    if (e instanceof GroupError && (e.status === 401 || e.status === 403)) emit({ sync: "revoked" });
    throw e;
  }
}

if (typeof window !== "undefined"){
  window.addEventListener("online", () => { if (snap.sync === "offline") emit({ sync: "idle" }); void flush(); });
  void flush();
}
