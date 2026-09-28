/* Group sync: phones that share an invite share one song cooldown and one list
   of finished shows. There are no accounts; the invite is a bearer secret
   ("<groupId>.<secret>") and only its SHA-256 is stored. The creating phone
   also gets an owner secret, the only thing that can delete the group.
   Never stores audio or stream URLs: song keys, timestamps, names, scores. */
import { peopleHistory, peopleIds, personPlayStatements, playKind, purgePeopleStatements } from "./people.js";

export const TOKEN_RX = /^([a-z2-7]{12})\.([A-Za-z0-9_-]{22})$/;
export const EVENT_ID_RX = /^[A-Za-z0-9_-]{8,40}$/;
// songKey() output: lowercase letters and digits, single spaces, trimmed.
export const SONG_KEY_RX = /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u;
const LOCAL_ORIGIN_RX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const CONTROL_RX = /[\u0000-\u001f\u007f]/g;

export const LIMITS = {
  body: 16 * 1024,
  importBody: 64 * 1024,
  groupName: 32,
  name: 24,
  cast: 8,
  members: 6,
  score: 100000,
  rounds: 20,
  songs: 200,
  roundBatch: 50,
  importSongs: 1000,
  songKey: 120,
  pageSize: 50,
  // A result queued offline keeps its own finish time, within reason.
  resultBackdateDays: 30,
  // Tickets named on one request (a roster, a room's seats).
  people: 16,
};

export const DAY = 86400e3;
const KINDS = ["played", "tired"];
// Each history kind has its own table, so a Worker from before `tired` existed still writes plays.
const TABLES = { played: ["played", "last_played_at"], tired: ["tired", "last_tired_at"] };
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

export const days = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback) * DAY;
export const ttl = env => ({
  results: days(env.RESULT_TTL_DAYS, 365),
  played: days(env.PLAYED_TTL_DAYS, 30),
  idle: days(env.GROUP_IDLE_TTL_DAYS, 365),
});

export function randomBase32(n){
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => B32[b & 31]).join("");
}

export function randomSecret(){
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s){
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
export const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const fromHex = hex => new Uint8Array((hex.match(/../g) || []).map(h => parseInt(h, 16)));

export function sameHash(a, hex){
  const b = fromHex(hex);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export function allowedOrigin(origin, env){
  if (!origin) return null;
  if (LOCAL_ORIGIN_RX.test(origin)) return origin;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

export function reply(body, status, origin){
  const headers = {
    "cache-control": "no-store",
    vary: "Origin",
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
  };
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

export async function readJson(request, max){
  if (Number(request.headers.get("content-length") || 0) > max) throw new HttpError(413, "request body is too large");
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "request body is too large");
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, "request body must be JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "request body must be a JSON object");
  return v;
}

export function cleanText(v, max, what){
  if (typeof v !== "string") throw new HttpError(400, `${what} must be text`);
  const t = v.replace(CONTROL_RX, "").trim();
  if (!t) throw new HttpError(400, `${what} is required`);
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t;
}

export function int(v, lo, hi, what){
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`);
  return v;
}

export function oneOf(v, options, what){
  if (!options.includes(v)) throw new HttpError(400, `${what} must be one of ${options.join(", ")}`);
  return v;
}

export function songKey(v){
  if (typeof v !== "string" || v.length > LIMITS.songKey || !SONG_KEY_RX.test(v)) throw new HttpError(400, "song key is not valid");
  return v;
}

export async function limited(limiter, key){
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

export function bearer(request, what){
  const m = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, `${what} is required`);
  return m[1];
}

async function authenticate(request, env){
  return authenticateInvite(bearer(request, "an invite"), env);
}

export async function authenticateInvite(invite, env){
  const t = TOKEN_RX.exec(String(invite || ""));
  if (!t) throw new HttpError(401, "the invite is malformed");
  const [, id, secret] = t;
  const [row, hash] = await Promise.all([
    env.DB.prepare("SELECT id, name, member_hash, owner_hash, created_at, active_at FROM groups WHERE id = ?").bind(id).first(),
    sha256(secret),
  ]);
  // An idle-expired group is gone even before the sweep deletes it; checking
  // here also stops a write from refreshing active_at and reviving it.
  const expired = row && row.active_at < Date.now() - ttl(env).idle;
  const role = !row || expired ? null : sameHash(hash, row.owner_hash) ? "owner" : sameHash(hash, row.member_hash) ? "member" : null;
  if (!role) throw new HttpError(403, "this invite is not valid (the group may have been deleted)");
  return { group: { id: row.id, name: row.name, createdAt: row.created_at }, role };
}

async function createGroup(request, env){
  const body = await readJson(request, LIMITS.body);
  const name = cleanText(body.name, LIMITS.groupName, "group name");
  const id = randomBase32(12);
  const secret = randomSecret();
  const ownerSecret = randomSecret();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO groups (id, name, member_hash, owner_hash, created_at, active_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, name, toHex(await sha256(secret)), toHex(await sha256(ownerSecret)), now, now).run();
  return [{ group: { id, name, createdAt: now }, role: "owner", invite: `${id}.${secret}`, owner: `${id}.${ownerSecret}` }, 201];
}

/* The group's cooldown, plus the histories of the group members named in
   ?people= (ticket ids, not secrets) so a phone can leave out what the people
   in the room have heard. Ids outside this group are ignored, never served. */
async function played(env, auth, url){
  const since = Date.now() - ttl(env).played;
  const wanted = String(url.searchParams.get("people") || "").split(",").filter(Boolean).slice(0, LIMITS.people);
  const [rows, members] = await Promise.all([
    env.DB.batch(KINDS.map(kind => {
      const [table, at] = TABLES[kind];
      return env.DB.prepare(`SELECT song_key, ${at} AS at FROM ${table} WHERE group_id = ? AND ${at} > ?`).bind(auth.group.id, since);
    })),
    wanted.length ? groupMembers(env, auth.group.id, wanted) : [],
  ]);
  const people = members.length ? await peopleHistory(env, members, since) : {};
  return [{ ...Object.fromEntries(KINDS.map((kind, i) => [kind, Object.fromEntries(rows[i].results.map(r => [r.song_key, r.at]))])), people }];
}

async function groupMembers(env, gid, ids){
  const { results } = await env.DB.prepare(
    `SELECT person_id FROM group_people WHERE group_id = ?1 AND person_id IN (SELECT value FROM json_each(?2))`,
  ).bind(gid, JSON.stringify(ids)).all();
  return results.map(r => r.person_id);
}

async function groupPeople(env, auth){
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name FROM group_people gp JOIN people p ON p.id = gp.person_id WHERE gp.group_id = ? ORDER BY gp.joined_at`,
  ).bind(auth.group.id).all();
  return [{ people: results.map(r => ({ id: r.id, name: r.name })) }];
}

async function results(env, auth, url){
  const now = Date.now();
  const before = Number(url.searchParams.get("before")) || now + 1;
  const size = Math.min(LIMITS.pageSize, Math.max(1, parseInt(url.searchParams.get("limit")) || 20));
  const { results: rows } = await env.DB.prepare(
    `SELECT result_id, finished_at, mode, difficulty, mix, rounds, songs, cast_json FROM results
     WHERE group_id = ? AND finished_at > ? AND finished_at < ?
     ORDER BY finished_at DESC LIMIT ?`,
  ).bind(auth.group.id, now - ttl(env).results, before, size + 1).all();
  const list = rows.slice(0, size).map(r => ({
    id: r.result_id, finishedAt: r.finished_at, mode: r.mode, difficulty: r.difficulty, mix: r.mix,
    rounds: r.rounds, songs: r.songs, cast: JSON.parse(r.cast_json),
  }));
  return [{ results: list, more: rows.length > size }];
}

/* Each round is an event with a client-made id and a server timestamp. A
   retried event keeps its first timestamp, and the cooldown only ever moves
   forward (MAX), so late or repeated requests cannot shorten it. */
async function postRounds(request, env, auth){
  const body = await readJson(request, LIMITS.body);
  if (!Array.isArray(body.rounds) || !body.rounds.length || body.rounds.length > LIMITS.roundBatch)
    throw new HttpError(400, `rounds must be a list of 1 to ${LIMITS.roundBatch} songs`);
  const rounds = body.rounds.map(r => {
    if (!r || typeof r.id !== "string" || !EVENT_ID_RX.test(r.id)) throw new HttpError(400, "round id is not valid");
    return { id: r.id, key: songKey(r.key), kind: playKind(r.kind), people: peopleIds(r.people) };
  });
  const json = JSON.stringify(rounds.map(r => ({ id: r.id, key: r.key, kind: r.kind })));
  const now = Date.now();
  const gid = auth.group.id;
  // Plays for the group's people: any phone in the group may record them,
  // but only for tickets that joined this group.
  const named = [...new Set(rounds.flatMap(r => r.people))];
  const members = new Set(named.length ? await groupMembers(env, gid, named) : []);
  const personRounds = rounds.filter(r => r.people.some(p => members.has(p))).map(r => ({ ...r, people: r.people.filter(p => members.has(p)) }));
  await env.DB.batch([
    ...personPlayStatements(env, personRounds, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO round_events (group_id, event_id, song_key, kind, played_at)
       SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.key'), json_extract(value, '$.kind'), ?3 FROM json_each(?2)`,
    ).bind(gid, json, now),
    ...KINDS.map(kind => {
      const [table, at] = TABLES[kind];
      return env.DB.prepare(
        `INSERT INTO ${table} (group_id, song_key, ${at})
         SELECT group_id, song_key, MAX(played_at) FROM round_events
         WHERE group_id = ?1 AND kind = ?3 AND event_id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
         GROUP BY song_key
         ON CONFLICT (group_id, song_key) DO UPDATE SET ${at} = MAX(${at}, excluded.${at})`,
      ).bind(gid, json, kind);
    }),
    env.DB.prepare("UPDATE groups SET active_at = ? WHERE id = ?").bind(now, gid),
  ]);
  return [{ ok: true, count: rounds.length }];
}

async function postResult(request, env, auth){
  const body = await readJson(request, LIMITS.body);
  if (typeof body.id !== "string" || !EVENT_ID_RX.test(body.id)) throw new HttpError(400, "result id is not valid");
  if (!Array.isArray(body.cast) || !body.cast.length || body.cast.length > LIMITS.cast)
    throw new HttpError(400, `cast must list 1 to ${LIMITS.cast} players or teams`);
  const cast = body.cast.map(c => {
    if (!c || typeof c !== "object") throw new HttpError(400, "cast entry is not valid");
    const members = c.members === undefined ? [] : c.members;
    if (!Array.isArray(members) || members.length > LIMITS.members) throw new HttpError(400, `a team has at most ${LIMITS.members} members`);
    return {
      name: cleanText(c.name, LIMITS.name, "name"),
      score: int(c.score, 0, LIMITS.score, "score"),
      members: members.map(m => cleanText(m, LIMITS.name, "member name")),
    };
  });
  const now = Date.now();
  const finishedAt = Number.isInteger(body.finishedAt) && body.finishedAt <= now && body.finishedAt > now - LIMITS.resultBackdateDays * DAY
    ? body.finishedAt : now;
  const row = [
    body.id, finishedAt,
    oneOf(body.mode, ["players", "teams"], "mode"),
    oneOf(body.difficulty, ["easy", "medium", "hard"], "difficulty"),
    oneOf(body.mix, ["bolly", "telugu", "both"], "mix"),
    int(body.rounds, 1, LIMITS.rounds, "rounds"),
    int(body.songs, 0, LIMITS.songs, "songs"),
    JSON.stringify(cast),
  ];
  const gid = auth.group.id;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO results (group_id, result_id, finished_at, mode, difficulty, mix, rounds, songs, cast_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(gid, ...row),
    env.DB.prepare("UPDATE groups SET active_at = ? WHERE id = ?").bind(now, gid),
  ]);
  return [{ ok: true }];
}

/* One-time import of a phone's own history ({ played, tired }, each song key
   to time). Client timestamps are accepted here (the plays happened before the
   group existed) but clamped to the retention window and never into the future. */
async function postImport(request, env, auth){
  const body = await readJson(request, LIMITS.importBody);
  const now = Date.now();
  const since = now - ttl(env).played;
  const keep = [];
  for (const kind of KINDS){
    const raw = body[kind] === undefined && kind === "tired" ? {} : body[kind];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `${kind} must be an object of song key to time`);
    for (const [k, v] of Object.entries(raw)){
      songKey(k);
      if (Number.isFinite(v) && v > since) keep.push({ key: k, kind, at: Math.min(Math.round(v), now) });
    }
  }
  if (keep.length > LIMITS.importSongs) throw new HttpError(400, `at most ${LIMITS.importSongs} songs can be imported`);
  const gid = auth.group.id;
  const statements = KINDS.filter(kind => keep.some(e => e.kind === kind)).map(kind => {
    const [table, at] = TABLES[kind];
    return env.DB.prepare(
      `INSERT INTO ${table} (group_id, song_key, ${at})
       SELECT ?1, json_extract(value, '$.key'), json_extract(value, '$.at') FROM json_each(?2) WHERE json_extract(value, '$.kind') = ?3
       ON CONFLICT (group_id, song_key) DO UPDATE SET ${at} = MAX(${at}, excluded.${at})`,
    ).bind(gid, JSON.stringify(keep), kind);
  });
  statements.push(env.DB.prepare("UPDATE groups SET active_at = ? WHERE id = ?").bind(now, gid));
  await env.DB.batch(statements);
  return [{ ok: true, imported: keep.length }];
}

async function deleteGroup(env, auth){
  if (auth.role !== "owner") throw new HttpError(403, "only the phone that made the group can delete it");
  const gid = auth.group.id;
  await env.DB.batch(["round_events", "played", "tired", "results", "group_people"].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE group_id = ?`).bind(gid))
    .concat(env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(gid)));
  return [null, 204];
}

const ROUTES = {
  "GET /api/group": (req, env, auth) => [auth],
  "DELETE /api/group": (req, env, auth) => deleteGroup(env, auth),
  "GET /api/group/played": (req, env, auth, url) => played(env, auth, url),
  "GET /api/group/people": (req, env, auth) => groupPeople(env, auth),
  "GET /api/group/results": (req, env, auth, url) => results(env, auth, url),
  "POST /api/group/rounds": (req, env, auth) => postRounds(req, env, auth),
  "POST /api/group/results": (req, env, auth) => postResult(req, env, auth),
  "POST /api/group/import": (req, env, auth) => postImport(req, env, auth),
};

export const isGroupPath = path => path === "/api/groups" || path === "/api/group" || path.startsWith("/api/group/");

export async function group(request, env, url, ctx){
  const originHeader = request.headers.get("origin");
  const origin = allowedOrigin(originHeader, env);
  if (originHeader && !origin) return reply({ success: false, message: "origin not allowed" }, 403, null);
  if (request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-allow-methods": "GET, POST, DELETE",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
    } });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  try {
    if (await limited(env.REQUEST_LIMITER, ip)) throw new HttpError(429, "too many requests, try again in a minute");
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /api/groups"){
      if (await limited(env.CREATE_LIMITER, ip)) throw new HttpError(429, "too many new groups from here, try again in a minute");
      const [body, status] = await createGroup(request, env);
      return reply(body, status, origin);
    }
    const handler = ROUTES[route];
    if (!handler){
      const known = url.pathname === "/api/groups" || Object.keys(ROUTES).some(r => r.split(" ")[1] === url.pathname);
      throw new HttpError(known ? 405 : 404, known ? "method not allowed" : "not found");
    }
    const auth = await authenticate(request, env);
    if (request.method !== "GET" && await limited(env.WRITE_LIMITER, auth.group.id)) throw new HttpError(429, "this group is sending too fast, try again in a minute");
    const [body, status = 200] = await handler(request, env, auth, url);
    if (request.method !== "GET") ctx.waitUntil(sweep(env));
    return reply(body, status, origin);
  } catch (e){
    if (e instanceof HttpError) return reply({ success: false, message: e.message }, e.status, origin);
    console.error("group route failed", request.method, url.pathname, String(e?.message || e));
    return reply({ success: false, message: "server error" }, 500, origin);
  }
}

/* Retention runs off group writes, at most hourly per isolate: the free plan's
   cron triggers are all taken on this account. Reads filter by the same
   windows, so an expired row is never served even before it is deleted. */
const SWEEP_EVERY_MS = 3600e3;
let lastSweep = 0;
export function sweep(env){
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return Promise.resolve();
  lastSweep = Date.now();
  return purgeExpired(env).catch(e => console.error("retention sweep failed", String(e?.message || e)));
}

async function purgeExpired(env){
  const now = Date.now();
  const t = ttl(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM results WHERE finished_at < ?").bind(now - t.results),
    env.DB.prepare("DELETE FROM round_events WHERE played_at < ?").bind(now - t.played),
    env.DB.prepare("DELETE FROM played WHERE last_played_at < ?").bind(now - t.played),
    env.DB.prepare("DELETE FROM tired WHERE last_tired_at < ?").bind(now - t.played),
    env.DB.prepare("DELETE FROM groups WHERE active_at < ?").bind(now - t.idle),
    ...purgePeopleStatements(env, now, t),
  ]);
}
