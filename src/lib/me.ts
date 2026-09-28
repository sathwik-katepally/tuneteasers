/* Personal ticket client (docs/tickets.md). A ticket is an anonymous profile
   made on this phone: a name and a secret the Worker knows only as a hash.
   The person's song history and preferences follow the ticket to any phone,
   group or buzz-in room, and a passkey made with it recovers it on a new
   device. Everything here is optional: with no ticket, or with the Worker
   unreachable, the game runs on this phone's own history exactly as before.
   The blocked-artist list is mirrored into localStorage so it applies
   offline; plays and preference changes go through an outbox like the
   group's. */
import { useSyncExternalStore } from "react";
import { songKey } from "./utils.js";
import { cooldownOf, heardCount, loadBlocked, loadHistory, saveBlocked } from "./storage.js";
import {
  GroupError, call, currentGroup, fetchGroupPeople, groupHistory, localHistory, randomId, recordPlay as recordGroupPlay, type Group,
} from "./group";
import type { History, PlayKind, Settings } from "../types";

export interface Ticket {
  id: string;
  name: string;
  /* The bearer secret "<id>.<key>"; only this phone holds it. */
  ticket: string;
  passkeys: number;
  groups: string[];
}
export type Filters = Partial<Pick<Settings, "mix" | "eras" | "difficulty" | "categories">>;
export interface Prefs { blocked?: string[]; filters?: Filters }
export type MeSync = "idle" | "syncing" | "offline" | "revoked";
export interface MeSnapshot { me: Ticket | null; sync: MeSync; pending: number }

interface Round { id: string; key: string; kind: PlayKind }
interface Outbox { personId: string; rounds: Round[]; prefs: Prefs | null }
interface MeResponse { person: { id: string; name: string }; prefs: Prefs; passkeys: number; groups: { id: string; name: string }[]; ticket?: string }

const LS_ME = "tt_me";
const LS_OUTBOX = "tt_me_outbox";
const TICKET_RX = /([a-z2-7]{12}\.[A-Za-z0-9_-]{22})/;
const ROUND_BATCH = 50;
const OUTBOX_MAX = 500;
export const BROKEN_TICKET = "broken";

const lsGet = (k: string): unknown => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch {} };

export const parseTicket = (text: string) => { const m = TICKET_RX.exec(String(text || "").trim()); return m ? m[1] : ""; };
export const ticketLink = (ticket: string) => `${location.origin}${location.pathname}#me=${ticket}`;

/* A ticket moves to another phone as #me=<ticket>, stripped from the address
   bar at once so it never reaches a server log. */
export function takeTicketFromUrl(): string {
  if (!location.hash.startsWith("#me=")) return "";
  const t = parseTicket(location.hash.slice("#me=".length));
  history.replaceState(null, "", location.pathname + location.search);
  return t || BROKEN_TICKET;
}

function readMe(): Ticket | null {
  const m = lsGet(LS_ME) as Partial<Ticket> | null;
  if (!m || typeof m !== "object" || typeof m.ticket !== "string" || !parseTicket(m.ticket)) return null;
  return {
    id: m.ticket.split(".")[0], name: String(m.name || "Me").slice(0, 24), ticket: m.ticket,
    passkeys: Number(m.passkeys) || 0, groups: Array.isArray(m.groups) ? m.groups.filter(g => typeof g === "string") : [],
  };
}
function readOutbox(personId: string): Outbox {
  const o = lsGet(LS_OUTBOX) as Partial<Outbox> | null;
  if (!o || o.personId !== personId) return { personId, rounds: [], prefs: null };
  return {
    personId,
    rounds: Array.isArray(o.rounds) ? o.rounds.filter(r => r && typeof r.id === "string" && typeof r.key === "string").map(r => ({ id: r.id, key: r.key, kind: r.kind === "tired" ? "tired" : "played" })) : [],
    prefs: o.prefs && typeof o.prefs === "object" ? o.prefs : null,
  };
}
const pendingOf = (o: Outbox) => o.rounds.length + (o.prefs ? 1 : 0);

let snap: MeSnapshot = (() => {
  const me = readMe();
  return { me, sync: "idle", pending: me ? pendingOf(readOutbox(me.id)) : 0 };
})();
const listeners = new Set<() => void>();
function emit(patch: Partial<MeSnapshot>){
  snap = { ...snap, ...patch };
  listeners.forEach(l => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useMe = () => useSyncExternalStore(subscribe, () => snap);
export const currentTicket = () => snap.me;

function store(me: Ticket | null){
  if (me) lsSet(LS_ME, me); else { lsDel(LS_ME); lsDel(LS_OUTBOX); }
  emit({ me, ...(me ? {} : { pending: 0, sync: "idle" as MeSync }) });
}

const fromResponse = (r: MeResponse, ticket: string): Ticket =>
  ({ id: r.person.id, name: r.person.name, ticket, passkeys: r.passkeys || 0, groups: (r.groups || []).map(g => g.id) });

/* Preferences arriving from the ticket: the blocked list is written to this
   phone, the filters are handed back for the setup screen. */
function applyPrefs(prefs: Prefs | undefined): Prefs {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  if (Array.isArray(p.blocked)) saveBlocked(p.blocked.filter(a => typeof a === "string"));
  return p;
}

function revokedOr(e: unknown, fallback: MeSync): MeSync {
  return e instanceof GroupError && (e.status === 401 || e.status === 403) ? "revoked" : fallback;
}

export async function previewTicket(ticket: string){
  const r = await call<MeResponse>("/me", ticket);
  return r.person.name;
}

/* Takes a ticket made elsewhere (a move link, a passkey recovery) onto this
   phone, importing nothing: the ticket's own history and preferences win. */
export async function adoptTicket(ticket: string, given?: MeResponse): Promise<Prefs> {
  const r = given ?? await call<MeResponse>("/me", ticket);
  lsDel(LS_OUTBOX);
  store(fromResponse(r, ticket));
  emit({ pending: 0, sync: "idle" });
  const prefs = applyPrefs(r.prefs);
  await linkCurrentGroup();
  return prefs;
}

export async function createTicket(name: string, withHistory: boolean): Promise<Ticket> {
  const body = {
    name,
    ...(withHistory ? { history: localHistory(), prefs: { blocked: loadBlocked() as string[] } } : {}),
  };
  const r = await call<MeResponse>("/people", null, { body });
  const me = fromResponse(r, r.ticket!);
  lsDel(LS_OUTBOX);
  store(me);
  emit({ pending: 0, sync: "idle" });
  await linkCurrentGroup();
  return me;
}

/* Reads the ticket back (name, passkeys, groups, prefs) and makes sure it is
   in this phone's group. Returns the prefs to apply, or null offline. */
export async function refreshMe(): Promise<Prefs | null> {
  const me = snap.me;
  if (!me) return null;
  try {
    const r = await call<MeResponse>("/me", me.ticket);
    if (snap.me?.id !== me.id) return null;
    store(fromResponse(r, me.ticket));
    if (snap.sync !== "syncing") emit({ sync: "idle" });
    const prefs = applyPrefs(r.prefs);
    await linkCurrentGroup();
    void flush();
    return prefs;
  } catch (e){
    if (snap.me?.id === me.id) emit({ sync: revokedOr(e, "offline") });
    return null;
  }
}

/* The ticket joins whatever group this phone is in, so the group's phones may
   record plays for it and its name shows in their rosters. */
export async function linkCurrentGroup(group: Group | null = currentGroup()){
  const me = snap.me;
  if (!me || !group || me.groups.includes(group.id) || snap.sync === "revoked") return;
  try {
    await call("/me/groups", me.ticket, { body: { invite: group.invite } });
    if (snap.me?.id === me.id) store({ ...snap.me!, groups: [...snap.me!.groups, group.id] });
    void fetchGroupPeople();
  } catch (e){
    if (snap.me?.id === me.id && revokedOr(e, "offline") === "revoked") emit({ sync: "revoked" });
  }
}
export async function unlinkGroup(groupId: string){
  const me = snap.me;
  if (!me) return;
  if (snap.me) store({ ...snap.me, groups: snap.me.groups.filter(g => g !== groupId) });
  await call(`/me/groups/${groupId}`, me.ticket, { method: "DELETE" }).catch(() => {});
}

export function forgetTicket(){
  store(null);
}

export async function deleteTicket(){
  const me = snap.me;
  if (!me) return;
  try {
    await call("/me", me.ticket, { method: "DELETE" });
  } catch (e){
    // Already gone (deleted or recovered elsewhere) is as good as deleted here.
    if (!(e instanceof GroupError && (e.status === 401 || e.status === 403))) throw e;
  }
  store(null);
}

/* Preferences edited here go to the ticket through the outbox. */
export function syncBlocked(blocked: string[]){
  queuePrefs({ blocked });
}
let filtersTimer = 0;
export function syncFilters(s: Settings){
  if (!snap.me) return;
  clearTimeout(filtersTimer);
  filtersTimer = window.setTimeout(() => queuePrefs({ filters: { mix: s.mix, eras: s.eras, difficulty: s.difficulty, categories: s.categories } }), 800);
}
function queuePrefs(patch: Prefs){
  const me = snap.me;
  if (!me) return;
  const o = readOutbox(me.id);
  o.prefs = { ...(o.prefs || {}), ...patch };
  lsSet(LS_OUTBOX, o);
  emit({ pending: pendingOf(o) });
  void flush();
}

/* Every play in a show is recorded for the tickets present (`people`): the
   group's phones do it through the group (any phone in the group may, for
   its members), and this phone does it for its own ticket when no group
   covers it. */
export function recordPlays(title: string, kind: PlayKind = "played", people: string[] = []){
  const me = snap.me;
  const g = currentGroup();
  recordGroupPlay(title, kind, people);
  if (!me || !people.includes(me.id) || (g && me.groups.includes(g.id))) return;
  const key = songKey(title);
  if (!key) return;
  const o = readOutbox(me.id);
  o.rounds = [...o.rounds, { id: randomId(), key, kind }].slice(-OUTBOX_MAX);
  lsSet(LS_OUTBOX, o);
  emit({ pending: pendingOf(o) });
  void flush();
}

type FlushResult = "sent" | "failed" | "nothing";
let flushing: Promise<FlushResult> | null = null;
export function flush(): Promise<FlushResult> {
  if (!flushing) flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}
async function doFlush(): Promise<FlushResult> {
  const me = snap.me;
  if (!me || snap.sync === "revoked") return "nothing";
  const save = (o: Outbox) => { if (snap.me?.id === me.id){ lsSet(LS_OUTBOX, o); emit({ pending: pendingOf(o) }); } };
  if (!pendingOf(readOutbox(me.id))) return "nothing";
  emit({ sync: "syncing" });
  try {
    for (let o = readOutbox(me.id); pendingOf(o) && snap.me?.id === me.id; o = readOutbox(me.id)){
      if (o.rounds.length){
        const batch = o.rounds.slice(0, ROUND_BATCH);
        await sendOrDrop(() => call("/me/rounds", me.ticket, { body: { rounds: batch } }));
        const ids = new Set(batch.map(r => r.id));
        save({ ...readOutbox(me.id), rounds: readOutbox(me.id).rounds.filter(r => !ids.has(r.id)) });
      } else if (o.prefs){
        const prefs = o.prefs;
        await sendOrDrop(() => call("/me", me.ticket, { method: "PATCH", body: { prefs } }));
        const now = readOutbox(me.id);
        // Edits made while this one was in flight stay queued.
        save({ ...now, prefs: now.prefs && JSON.stringify(now.prefs) !== JSON.stringify(prefs) ? now.prefs : null });
      }
    }
    if (snap.me?.id === me.id) emit({ sync: "idle" });
    return "sent";
  } catch (e){
    if (snap.me?.id === me.id) emit({ sync: revokedOr(e, "offline") });
    return "failed";
  }
}
async function sendOrDrop(request: () => Promise<unknown>){
  try { await request(); }
  catch (e){ if (!(e instanceof GroupError && (e.status === 400 || e.status === 413))) throw e; }
}

/* The cooldown for a show with these people present: this phone's history,
   the group's and each present ticket's, folded into one until-map, plus how
   many of the people heard each song. Only what can be reached in time
   counts; with the Worker down the phone's own history alone remains. */
export async function presentCooldown(people: string[]): Promise<{ until: Record<string, number>; heardBy: Record<string, number> }> {
  const me = snap.me;
  const g = currentGroup();
  const [group, mine] = await Promise.all([
    g ? groupHistory(people) : Promise.resolve(null),
    me && people.includes(me.id) && !(g && me.groups.includes(g.id)) ? myHistory() : Promise.resolve(null),
  ]);
  const histories: History[] = Object.values(group?.people || {});
  if (mine && !group?.people[me!.id]) histories.push(mine);
  return { until: cooldownOf(loadHistory(), group, ...histories), heardBy: heardCount(...histories) };
}

async function myHistory(): Promise<History | null> {
  const me = snap.me;
  if (!me || snap.sync === "revoked") return null;
  if ((await flush()) === "failed") return null;
  try {
    const r = await call<History>("/me/played", me.ticket);
    return { played: r.played || {}, tired: r.tired || {} };
  } catch (e){
    if (snap.me?.id === me.id) emit({ sync: revokedOr(e, "offline") });
    return null;
  }
}

/* Passkeys (WebAuthn through @simplewebauthn/browser, loaded on demand). The
   Worker is the relying party for the site's own origin. */
export const passkeysSupported = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

export class PasskeyError extends Error {
  constructor(public kind: "unsupported" | "cancelled" | "failed", message: string){ super(message); }
}

async function webauthn(){
  return import("@simplewebauthn/browser");
}
function asPasskeyError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyError("cancelled", "The passkey prompt was closed.");
  if (e instanceof GroupError) return new PasskeyError("failed", e.status === 0 ? "Couldn't reach the ticket office. Check the connection." : e.message);
  return new PasskeyError("failed", String((e as Error)?.message || e).slice(0, 160));
}

export async function addPasskey(){
  const me = snap.me;
  if (!me) throw new PasskeyError("failed", "Make a ticket first.");
  if (!passkeysSupported()) throw new PasskeyError("unsupported", "This browser can't make passkeys.");
  try {
    const { options, challengeId } = await call<{ options: object; challengeId: string }>("/me/passkey/options", me.ticket, { body: {} });
    const { startRegistration } = await webauthn();
    const response = await startRegistration({ optionsJSON: options as never });
    const r = await call<{ passkeys: number }>("/me/passkey", me.ticket, { body: { challengeId, response } });
    if (snap.me?.id === me.id) store({ ...snap.me!, passkeys: r.passkeys });
    return r.passkeys;
  } catch (e){
    throw asPasskeyError(e);
  }
}

export async function recoverWithPasskey(): Promise<Prefs> {
  if (!passkeysSupported()) throw new PasskeyError("unsupported", "This browser can't use passkeys.");
  try {
    const { options, challengeId } = await call<{ options: object; challengeId: string }>("/people/recover/options", null, { body: {} });
    const { startAuthentication } = await webauthn();
    const response = await startAuthentication({ optionsJSON: options as never });
    const r = await call<MeResponse>("/people/recover", null, { body: { challengeId, response } });
    return adoptTicket(r.ticket!, r);
  } catch (e){
    throw asPasskeyError(e);
  }
}

if (typeof window !== "undefined"){
  window.addEventListener("online", () => { if (snap.sync === "offline") emit({ sync: "idle" }); void flush(); });
  void flush();
}
