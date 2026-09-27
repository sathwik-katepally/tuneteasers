/* Group sync: phones that share an invite share one song cooldown and one list
   of finished shows. There are no accounts; the invite is a bearer secret
   ("<groupId>.<secret>") and only its SHA-256 is stored. The creating phone
   also gets an owner secret, the only thing that can delete the group.
   Never stores audio or stream URLs: song keys, timestamps, names, scores. */

const TOKEN_RX = /^([a-z2-7]{12})\.([A-Za-z0-9_-]{22})$/;
const EVENT_ID_RX = /^[A-Za-z0-9_-]{8,40}$/;
// songKey() output: lowercase letters and digits, single spaces, trimmed.
const SONG_KEY_RX = /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)*$/u;
const LOCAL_ORIGIN_RX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const CONTROL_RX = /[\u0000-\u001f\u007f]/g;

const LIMITS = {
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
};

const DAY = 86400e3;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

const days = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback) * DAY;
const ttl = env => ({
  results: days(env.RESULT_TTL_DAYS, 365),
  played: days(env.PLAYED_TTL_DAYS, 30),
  idle: days(env.GROUP_IDLE_TTL_DAYS, 365),
});

function randomBase32(n){
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, b => B32[b & 31]).join("");
}

function randomSecret(){
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s){
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = hex => new Uint8Array((hex.match(/../g) || []).map(h => parseInt(h, 16)));

function sameHash(a, hex){
  const b = fromHex(hex);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export function allowedOrigin(origin, env){
  if (!origin) return null;
  if (LOCAL_ORIGIN_RX.test(origin)) return origin;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function reply(body, status, origin){
  const headers = {
    "cache-control": "no-store",
    vary: "Origin",
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
  };
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

async function readJson(request, max){
  if (Number(request.headers.get("content-length") || 0) > max) throw new HttpError(413, "request body is too large");
  const text = await request.text();
  if (text.length > max) throw new HttpError(413, "request body is too large");
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, "request body must be JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "request body must be a JSON object");
  return v;
}

function cleanText(v, max, what){
  if (typeof v !== "string") throw new HttpError(400, `${what} must be text`);
  const t = v.replace(CONTROL_RX, "").trim();
  if (!t) throw new HttpError(400, `${what} is required`);
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t;
}

function int(v, lo, hi, what){
  if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`);
  return v;
}

function oneOf(v, options, what){
  if (!options.includes(v)) throw new HttpError(400, `${what} must be one of ${options.join(", ")}`);
  return v;
}

function songKey(v){
  if (typeof v !== "string" || v.length > LIMITS.songKey || !SONG_KEY_RX.test(v)) throw new HttpError(400, "song key is not valid");
  return v;
}

async function limited(limiter, key){
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

async function authenticate(request, env){
  const m = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, "an invite is required");
  const t = TOKEN_RX.exec(m[1]);
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

async function played(env, auth){
  const since = Date.now() - ttl(env).played;
  const { results } = await env.DB.prepare("SELECT song_key, last_played_at FROM played WHERE group_id = ? AND last_played_at > ?")
    .bind(auth.group.id, since).all();
  return [{ played: Object.fromEntries(results.map(r => [r.song_key, r.last_played_at])) }];
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
    return { id: r.id, key: songKey(r.key) };
  });
  const json = JSON.stringify(rounds);
  const now = Date.now();
  const gid = auth.group.id;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO round_events (group_id, event_id, song_key, played_at)
       SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.key'), ?3 FROM json_each(?2)`,
    ).bind(gid, json, now),
    env.DB.prepare(
      `INSERT INTO played (group_id, song_key, last_played_at)
       SELECT group_id, song_key, MAX(played_at) FROM round_events
       WHERE group_id = ?1 AND event_id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
       GROUP BY song_key
       ON CONFLICT (group_id, song_key) DO UPDATE SET last_played_at = MAX(last_played_at, excluded.last_played_at)`,
    ).bind(gid, json),
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

/* One-time import of a phone's own cooldown map. Client timestamps are
   accepted here (the plays happened before the group existed) but clamped to
   the retention window and never into the future. */
async function postImport(request, env, auth){
  const body = await readJson(request, LIMITS.importBody);
  const raw = body.played;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "played must be an object of song key to time");
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.importSongs) throw new HttpError(400, `at most ${LIMITS.importSongs} songs can be imported`);
  const now = Date.now();
  const since = now - ttl(env).played;
  const keep = {};
  for (const [k, v] of entries){
    songKey(k);
    if (!Number.isFinite(v) || v <= since) continue;
    keep[k] = Math.min(Math.round(v), now);
  }
  const gid = auth.group.id;
  const statements = [env.DB.prepare("UPDATE groups SET active_at = ? WHERE id = ?").bind(now, gid)];
  if (Object.keys(keep).length) statements.unshift(env.DB.prepare(
    `INSERT INTO played (group_id, song_key, last_played_at)
     SELECT ?1, key, value FROM json_each(?2) WHERE true
     ON CONFLICT (group_id, song_key) DO UPDATE SET last_played_at = MAX(last_played_at, excluded.last_played_at)`,
  ).bind(gid, JSON.stringify(keep)));
  await env.DB.batch(statements);
  return [{ ok: true, imported: Object.keys(keep).length }];
}

async function deleteGroup(env, auth){
  if (auth.role !== "owner") throw new HttpError(403, "only the phone that made the group can delete it");
  const gid = auth.group.id;
  await env.DB.batch(["round_events", "played", "results"].map(t => env.DB.prepare(`DELETE FROM ${t} WHERE group_id = ?`).bind(gid))
    .concat(env.DB.prepare("DELETE FROM groups WHERE id = ?").bind(gid)));
  return [null, 204];
}

const ROUTES = {
  "GET /api/group": (req, env, auth) => [auth],
  "DELETE /api/group": (req, env, auth) => deleteGroup(env, auth),
  "GET /api/group/played": (req, env, auth) => played(env, auth),
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
function sweep(env){
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
    env.DB.prepare("DELETE FROM groups WHERE active_at < ?").bind(now - t.idle),
  ]);
}
