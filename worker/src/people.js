/* Personal tickets (docs/tickets.md): an anonymous per-person profile whose
   song history and preferences follow the person to any phone, group or
   buzz-in room. The ticket is a bearer secret "<personId>.<key>" made on the
   person's own phone; only its SHA-256 is stored. A passkey (WebAuthn) is
   registered alongside it so a lost phone can recover the ticket, which then
   gets a new key. Only the key holder reads or edits the person's preferences
   or deletes the ticket; plays may also be recorded for a person by any phone
   in a group the ticket joined (group.js) and by the host of a room the
   person is seated in (rooms.js). Song keys, timestamps, a name, blocked
   artists and default filters only; never audio, stream URLs or room data. */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  HttpError, LIMITS, TOKEN_RX, EVENT_ID_RX, allowedOrigin, authenticateInvite, bearer, cleanText, limited,
  oneOf, randomBase32, randomSecret, readJson, reply, sameHash, sha256, songKey, sweep, toHex, ttl,
} from "./group.js";

const RP_NAME = "Tune Teasers";
const CHALLENGE_TTL_MS = 5 * 60e3;
const KINDS = ["played", "tired"];
const PERSON_ID_RX = /^[a-z2-7]{12}$/;
const B64URL_RX = /^[A-Za-z0-9_-]{16,1024}$/;
const MIXES = ["bolly", "telugu", "both"];
const ERAS = ["2000s", "2010s", "2020s"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const CATEGORIES = ["dance", "romantic", "sad", "item", "mass"];
const P = {
  blocked: 50,
  artist: 120,
  passkeys: 10,
  webauthnBody: 64 * 1024,
};

export const playKind = v => (v === undefined ? "played" : oneOf(v, KINDS, "kind"));

export function peopleIds(v){
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > LIMITS.people) throw new HttpError(400, `people must list at most ${LIMITS.people} tickets`);
  for (const id of v) if (typeof id !== "string" || !PERSON_ID_RX.test(id)) throw new HttpError(400, "person id is not valid");
  return [...new Set(v)];
}

/* One D1 statement pair per kind, same idempotency as group rounds: the
   event keeps its first timestamp, the cooldown only moves forward. */
export function personPlayStatements(env, rounds, now){
  const rows = rounds.flatMap(r => r.people.map(p => ({ person: p, id: r.id, key: r.key, kind: r.kind })));
  if (!rows.length) return [];
  const json = JSON.stringify(rows);
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO person_events (person_id, event_id, song_key, kind, played_at)
       SELECT json_extract(value, '$.person'), json_extract(value, '$.id'), json_extract(value, '$.key'), json_extract(value, '$.kind'), ?2 FROM json_each(?1)`,
    ).bind(json, now),
    env.DB.prepare(
      `INSERT INTO person_played (person_id, song_key, kind, last_played_at)
       SELECT person_id, song_key, kind, MAX(played_at) FROM person_events
       WHERE (person_id, event_id) IN (SELECT json_extract(value, '$.person'), json_extract(value, '$.id') FROM json_each(?1))
       GROUP BY person_id, song_key, kind
       ON CONFLICT (person_id, song_key, kind) DO UPDATE SET last_played_at = MAX(last_played_at, excluded.last_played_at)`,
    ).bind(json),
    env.DB.prepare(`UPDATE people SET active_at = ?2 WHERE id IN (SELECT DISTINCT json_extract(value, '$.person') FROM json_each(?1))`).bind(json, now),
  ];
}

/* { personId: { played: { key: ms }, tired: { key: ms } } } within the window. */
export async function peopleHistory(env, ids, since){
  const out = Object.fromEntries(ids.map(id => [id, { played: {}, tired: {} }]));
  if (!ids.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT person_id, song_key, kind, last_played_at FROM person_played
     WHERE person_id IN (SELECT value FROM json_each(?1)) AND last_played_at > ?2`,
  ).bind(JSON.stringify(ids), since).all();
  for (const r of results){
    const h = out[r.person_id];
    if (h && h[r.kind]) h[r.kind][r.song_key] = r.last_played_at;
  }
  return out;
}

export function purgePeopleStatements(env, now, t){
  return [
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM person_events WHERE played_at < ?").bind(now - t.played),
    env.DB.prepare("DELETE FROM person_played WHERE last_played_at < ?").bind(now - t.played),
    ...deletePeopleStatements(env, "SELECT id FROM people WHERE active_at < ?", now - t.idle),
  ];
}

const PERSON_TABLES = ["person_events", "person_played", "group_people", "passkeys", "webauthn_challenges"];
function deletePeopleStatements(env, subselect, ...binds){
  return PERSON_TABLES.map(tb => env.DB.prepare(`DELETE FROM ${tb} WHERE person_id IN (${subselect})`).bind(...binds))
    .concat(env.DB.prepare(`DELETE FROM people WHERE id IN (${subselect})`).bind(...binds));
}

/* Validated preferences: blocked artists and the setup screen's defaults. */
function cleanPrefs(v){
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "prefs must be an object");
  const out = {};
  if (v.blocked !== undefined){
    if (!Array.isArray(v.blocked) || v.blocked.length > P.blocked) throw new HttpError(400, `at most ${P.blocked} artists can be blocked`);
    const seen = new Set();
    out.blocked = [];
    for (const a of v.blocked){
      const t = cleanText(a, P.artist, "artist");
      if (!seen.has(t.toLowerCase())){ seen.add(t.toLowerCase()); out.blocked.push(t); }
    }
  }
  if (v.filters !== undefined){
    const f = v.filters;
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new HttpError(400, "filters must be an object");
    out.filters = {
      ...(f.mix !== undefined ? { mix: oneOf(f.mix, MIXES, "mix") } : {}),
      ...(f.difficulty !== undefined ? { difficulty: oneOf(f.difficulty, DIFFICULTIES, "difficulty") } : {}),
      ...(f.eras !== undefined ? { eras: listOf(f.eras, ERAS, "eras") } : {}),
      ...(f.categories !== undefined ? { categories: listOf(f.categories, CATEGORIES, "categories") } : {}),
    };
  }
  return out;
}
function listOf(v, options, what){
  if (!Array.isArray(v) || v.length > options.length) throw new HttpError(400, `${what} must be a short list`);
  return [...new Set(v.map(x => oneOf(x, options, what)))];
}

function historyMaps(v, env, now){
  const out = { played: {}, tired: {} };
  if (v === undefined) return out;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "history must be an object");
  const since = now - ttl(env).played;
  for (const kind of KINDS){
    const raw = v[kind];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `${kind} must be an object of song key to time`);
    const entries = Object.entries(raw);
    if (entries.length > LIMITS.importSongs) throw new HttpError(400, `at most ${LIMITS.importSongs} songs can be imported`);
    for (const [k, t] of entries){
      songKey(k);
      if (!Number.isFinite(t) || t <= since) continue;
      out[kind][k] = Math.min(Math.round(t), now);
    }
  }
  return out;
}
function importStatements(env, personId, history){
  const statements = [];
  for (const kind of KINDS){
    if (!Object.keys(history[kind]).length) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO person_played (person_id, song_key, kind, last_played_at)
       SELECT ?1, key, ?3, value FROM json_each(?2) WHERE true
       ON CONFLICT (person_id, song_key, kind) DO UPDATE SET last_played_at = MAX(last_played_at, excluded.last_played_at)`,
    ).bind(personId, JSON.stringify(history[kind]), kind));
  }
  return statements;
}

const personOf = row => ({ id: row.id, name: row.name, createdAt: row.created_at });
const prefsOf = row => { try { return JSON.parse(row.prefs_json) || {}; } catch { return {}; } };

async function authenticateTicket(request, env){
  const t = TOKEN_RX.exec(bearer(request, "a ticket"));
  if (!t) throw new HttpError(401, "the ticket is malformed");
  const [, id, key] = t;
  const [row, hash] = await Promise.all([
    env.DB.prepare("SELECT id, name, key_hash, prefs_json, created_at, active_at FROM people WHERE id = ?").bind(id).first(),
    sha256(key),
  ]);
  const expired = row && row.active_at < Date.now() - ttl(env).idle;
  if (!row || expired || !sameHash(hash, row.key_hash)) throw new HttpError(403, "this ticket is not valid (it may have been deleted or recovered on another phone)");
  return { person: personOf(row), prefs: prefsOf(row), row };
}

async function createPerson(request, env){
  const body = await readJson(request, LIMITS.importBody);
  const name = cleanText(body.name, LIMITS.name, "name");
  const prefs = cleanPrefs(body.prefs) || {};
  const now = Date.now();
  const history = historyMaps(body.history, env, now);
  const id = randomBase32(12);
  const key = randomSecret();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people (id, name, key_hash, prefs_json, created_at, active_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, name, toHex(await sha256(key)), JSON.stringify(prefs), now, now),
    ...importStatements(env, id, history),
  ]);
  const imported = Object.keys(history.played).length + Object.keys(history.tired).length;
  return [{ person: { id, name, createdAt: now }, prefs, passkeys: 0, groups: [], ticket: `${id}.${key}`, imported }, 201];
}

async function me(env, auth){
  const [{ results: groups }, passkeys] = await Promise.all([
    env.DB.prepare("SELECT g.id, g.name FROM group_people gp JOIN groups g ON g.id = gp.group_id WHERE gp.person_id = ? ORDER BY gp.joined_at").bind(auth.person.id).all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE person_id = ?").bind(auth.person.id).first("n"),
  ]);
  return [{ person: auth.person, prefs: auth.prefs, passkeys: Number(passkeys) || 0, groups: groups.map(g => ({ id: g.id, name: g.name })) }];
}

async function patchMe(request, env, auth){
  const body = await readJson(request, LIMITS.body);
  const name = body.name === undefined ? auth.person.name : cleanText(body.name, LIMITS.name, "name");
  const patch = cleanPrefs(body.prefs);
  const prefs = patch ? { ...auth.prefs, ...patch } : auth.prefs;
  const now = Date.now();
  await env.DB.prepare("UPDATE people SET name = ?, prefs_json = ?, active_at = ? WHERE id = ?").bind(name, JSON.stringify(prefs), now, auth.person.id).run();
  return [{ person: { ...auth.person, name }, prefs }];
}

async function deleteMe(env, auth){
  await env.DB.batch(deletePeopleStatements(env, "SELECT ?", auth.person.id));
  return [null, 204];
}

async function myPlayed(env, auth){
  const since = Date.now() - ttl(env).played;
  const h = await peopleHistory(env, [auth.person.id], since);
  return [h[auth.person.id]];
}

async function postMyRounds(request, env, auth){
  const body = await readJson(request, LIMITS.body);
  if (!Array.isArray(body.rounds) || !body.rounds.length || body.rounds.length > LIMITS.roundBatch)
    throw new HttpError(400, `rounds must be a list of 1 to ${LIMITS.roundBatch} songs`);
  const rounds = body.rounds.map(r => {
    if (!r || typeof r.id !== "string" || !EVENT_ID_RX.test(r.id)) throw new HttpError(400, "round id is not valid");
    return { id: r.id, key: songKey(r.key), kind: playKind(r.kind), people: [auth.person.id] };
  });
  await env.DB.batch(personPlayStatements(env, rounds, Date.now()));
  return [{ ok: true, count: rounds.length }];
}

/* Joining a group with a ticket needs both secrets: the ticket (bearer) and
   the group's invite (body). Membership is what later lets any phone in the
   group record plays for this person. */
async function joinGroup(request, env, auth){
  const body = await readJson(request, LIMITS.body);
  const g = await authenticateInvite(body.invite, env);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO group_people (group_id, person_id, joined_at) VALUES (?, ?, ?)").bind(g.group.id, auth.person.id, now),
    env.DB.prepare("UPDATE people SET active_at = ? WHERE id = ?").bind(now, auth.person.id),
  ]);
  return [{ ok: true, group: g.group }];
}

async function leaveGroup(env, auth, groupId){
  if (!/^[a-z2-7]{12}$/.test(groupId)) throw new HttpError(400, "group id is not valid");
  await env.DB.prepare("DELETE FROM group_people WHERE group_id = ? AND person_id = ?").bind(groupId, auth.person.id).run();
  return [null, 204];
}

/* WebAuthn. The relying party is the site the request came from: the Pages
   origin in production, localhost in tests. Challenges live in D1 for a few
   minutes under a random id the client hands back with the response. */
function relyingParty(origin){
  if (!origin) throw new HttpError(403, "passkeys need the game's origin");
  return { rpID: new URL(origin).hostname, origin };
}

async function saveChallenge(env, challenge, purpose, personId){
  const id = randomSecret();
  await env.DB.prepare("INSERT INTO webauthn_challenges (id, challenge, purpose, person_id, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, challenge, purpose, personId, Date.now() + CHALLENGE_TTL_MS).run();
  return id;
}

async function takeChallenge(env, id, purpose, personId){
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw new HttpError(400, "challenge id is not valid");
  const row = await env.DB.prepare("SELECT challenge, purpose, person_id, expires_at FROM webauthn_challenges WHERE id = ?").bind(id).first();
  await env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(id).run();
  if (!row || row.purpose !== purpose || row.expires_at < Date.now() || (personId !== undefined && row.person_id !== personId))
    throw new HttpError(400, "this passkey request has expired, try again");
  return row.challenge;
}

function webauthnResponse(v){
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !B64URL_RX.test(v.id) || !v.response || typeof v.response !== "object")
    throw new HttpError(400, "passkey response is not valid");
  return v;
}

const b64u = {
  encode: bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)),
};

async function passkeyOptions(env, auth, origin){
  const { rpID } = relyingParty(origin);
  const { results: existing } = await env.DB.prepare("SELECT credential_id, transports_json FROM passkeys WHERE person_id = ?").bind(auth.person.id).all();
  if (existing.length >= P.passkeys) throw new HttpError(400, `a ticket holds at most ${P.passkeys} passkeys`);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(auth.person.id),
    userName: auth.person.name,
    userDisplayName: auth.person.name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    excludeCredentials: existing.map(r => ({ id: r.credential_id, transports: JSON.parse(r.transports_json) })),
  });
  const challengeId = await saveChallenge(env, options.challenge, "register", auth.person.id);
  return [{ options, challengeId }];
}

async function addPasskey(request, env, auth, origin){
  const rp = relyingParty(origin);
  const body = await readJson(request, P.webauthnBody);
  const response = webauthnResponse(body.response);
  const expectedChallenge = await takeChallenge(env, body.challengeId, "register", auth.person.id);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
    });
  } catch (e){
    throw new HttpError(400, `passkey could not be verified: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, "passkey could not be verified");
  const c = verification.registrationInfo.credential;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO passkeys (credential_id, person_id, public_key, counter, transports_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.id, auth.person.id, b64u.encode(c.publicKey), c.counter, JSON.stringify(c.transports || []), now),
    env.DB.prepare("UPDATE people SET active_at = ? WHERE id = ?").bind(now, auth.person.id),
  ]);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE person_id = ?").bind(auth.person.id).first("n");
  return [{ ok: true, passkeys: Number(n) || 0 }, 201];
}

async function recoverOptions(env, origin){
  const { rpID } = relyingParty(origin);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: [] });
  const challengeId = await saveChallenge(env, options.challenge, "recover", null);
  return [{ options, challengeId }];
}

/* A verified passkey assertion hands the ticket to this device with a fresh
   key, so the phone it was lost on cannot use it any more. */
async function recover(request, env, origin){
  const rp = relyingParty(origin);
  const body = await readJson(request, P.webauthnBody);
  const response = webauthnResponse(body.response);
  const expectedChallenge = await takeChallenge(env, body.challengeId, "recover");
  const row = await env.DB.prepare(
    `SELECT k.credential_id, k.public_key, k.counter, k.transports_json, p.id, p.name, p.prefs_json, p.created_at, p.active_at
     FROM passkeys k JOIN people p ON p.id = k.person_id WHERE k.credential_id = ?`,
  ).bind(response.id).first();
  if (!row || row.active_at < Date.now() - ttl(env).idle) throw new HttpError(403, "no ticket has this passkey");
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false,
      credential: { id: row.credential_id, publicKey: b64u.decode(row.public_key), counter: row.counter, transports: JSON.parse(row.transports_json) },
    });
  } catch (e){
    throw new HttpError(403, `passkey could not be verified: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!verification.verified) throw new HttpError(403, "passkey could not be verified");
  const key = randomSecret();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE passkeys SET counter = ? WHERE credential_id = ?").bind(verification.authenticationInfo.newCounter, row.credential_id),
    env.DB.prepare("UPDATE people SET key_hash = ?, active_at = ? WHERE id = ?").bind(toHex(await sha256(key)), now, row.id),
  ]);
  const auth = { person: personOf(row), prefs: prefsOf(row) };
  const [body2] = await me(env, auth);
  return [{ ...body2, ticket: `${row.id}.${key}` }];
}

const OPEN = {
  "POST /api/people": (req, env, origin) => createPerson(req, env),
  "POST /api/people/recover/options": (req, env, origin) => recoverOptions(env, origin),
  "POST /api/people/recover": (req, env, origin) => recover(req, env, origin),
};
const ROUTES = {
  "GET /api/me": (req, env, auth) => me(env, auth),
  "PATCH /api/me": (req, env, auth) => patchMe(req, env, auth),
  "DELETE /api/me": (req, env, auth) => deleteMe(env, auth),
  "GET /api/me/played": (req, env, auth) => myPlayed(env, auth),
  "POST /api/me/rounds": (req, env, auth) => postMyRounds(req, env, auth),
  "POST /api/me/groups": (req, env, auth) => joinGroup(req, env, auth),
  "POST /api/me/passkey/options": (req, env, auth, origin) => passkeyOptions(env, auth, origin),
  "POST /api/me/passkey": (req, env, auth, origin) => addPasskey(req, env, auth, origin),
};

export const isPeoplePath = path => path === "/api/people" || path.startsWith("/api/people/") || path === "/api/me" || path.startsWith("/api/me/");

export async function people(request, env, url, ctx){
  const originHeader = request.headers.get("origin");
  const origin = allowedOrigin(originHeader, env);
  if (originHeader && !origin) return reply({ success: false, message: "origin not allowed" }, 403, null);
  if (request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-allow-methods": "GET, POST, PATCH, DELETE",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
    } });
  }
  const ip = request.headers.get("cf-connecting-ip") || "local";
  try {
    if (await limited(env.REQUEST_LIMITER, ip)) throw new HttpError(429, "too many requests, try again in a minute");
    const route = `${request.method} ${url.pathname}`;
    const open = OPEN[route];
    if (open){
      // New tickets and recovery attempts share the group-creation budget per IP.
      if (await limited(env.CREATE_LIMITER, `people:${ip}`)) throw new HttpError(429, "too many tries from here, try again in a minute");
      const [body, status = 200] = await open(request, env, origin);
      return reply(body, status, origin);
    }
    const leave = /^\/api\/me\/groups\/([a-z2-7]{12})$/.exec(url.pathname);
    const handler = leave && request.method === "DELETE" ? (req, env, auth) => leaveGroup(env, auth, leave[1]) : ROUTES[route];
    if (!handler){
      const known = Object.keys(ROUTES).concat(Object.keys(OPEN)).some(r => r.split(" ")[1] === url.pathname) || leave;
      throw new HttpError(known ? 405 : 404, known ? "method not allowed" : "not found");
    }
    const auth = await authenticateTicket(request, env);
    if (request.method !== "GET" && await limited(env.WRITE_LIMITER, `person:${auth.person.id}`)) throw new HttpError(429, "this ticket is sending too fast, try again in a minute");
    const [body, status = 200] = await handler(request, env, auth, origin);
    if (request.method !== "GET") ctx.waitUntil(sweep(env));
    return reply(body, status, origin);
  } catch (e){
    if (e instanceof HttpError) return reply({ success: false, message: e.message }, e.status, origin);
    console.error("people route failed", request.method, url.pathname, String(e?.message || e));
    return reply({ success: false, message: "server error" }, 500, origin);
  }
}

/* For rooms.js: the seated people's histories, and plays for them. */
export async function seatedHistory(env, ids){
  return peopleHistory(env, ids, Date.now() - ttl(env).played);
}
export async function recordSeatedPlays(request, env, ids){
  const body = await readJson(request, LIMITS.body);
  if (!Array.isArray(body.rounds) || !body.rounds.length || body.rounds.length > LIMITS.roundBatch)
    throw new HttpError(400, `rounds must be a list of 1 to ${LIMITS.roundBatch} songs`);
  const rounds = body.rounds.map(r => {
    if (!r || typeof r.id !== "string" || !EVENT_ID_RX.test(r.id)) throw new HttpError(400, "round id is not valid");
    return { id: r.id, key: songKey(r.key), kind: playKind(r.kind), people: ids };
  });
  if (ids.length) await env.DB.batch(personPlayStatements(env, rounds, Date.now()));
  return { ok: true, count: rounds.length, people: ids.length };
}
