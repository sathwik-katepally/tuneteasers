/* HTTP side of buzz-in rooms: making a room, and letting a WebSocket through
   to its Durable Object (src/room.js). */
import { getServerByName, routePartykitRequest } from "partyserver";
import { allowedOrigin, HttpError, limited } from "./group.js";
import { recordSeatedPlays, seatedHistory } from "./people.js";
import { CODE_RX, randomCode } from "./room.js";

const CLAIM_TRIES = 6;

const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  vary: "Origin",
  ...(origin ? { "access-control-allow-origin": origin } : {}),
} });

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function sha256Hex(s){
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, x => x.toString(16).padStart(2, "0")).join("");
}

export const isRoomPath = path => path === "/api/rooms" || path.startsWith("/api/rooms/") || path.startsWith("/parties/");
const HOST_TOKEN_RX = /^[A-Za-z0-9_-]{22}$/;

/* The host's two ticket routes (docs/tickets.md): the seated tickets' song
   histories when the show starts, and a played song for all of them after
   each reveal. The host proves itself with its host secret and the room's
   Durable Object says who is seated; song keys are all that is written. */
async function hostRoute(request, env, url, origin, ip){
  const m = /^\/api\/rooms\/([A-Z]{4})\/(history|rounds)$/.exec(url.pathname);
  if (!m) return json({ success: false, message: "not found" }, 404, origin);
  if (request.method === "OPTIONS"){
    return new Response(null, { status: 204, headers: {
      "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400", vary: "Origin",
    } });
  }
  try {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed");
    if (await limited(env.REQUEST_LIMITER, ip)) throw new HttpError(429, "too many requests, try again in a minute");
    const [, code, what] = m;
    if (!CODE_RX.test(code)) throw new HttpError(404, "no such room");
    const t = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "");
    if (!t || !HOST_TOKEN_RX.test(t[1])) throw new HttpError(401, "the host secret is required");
    const stub = await getServerByName(env.Room, code);
    const ids = await stub.seated(await sha256Hex(t[1]));
    if (!ids) throw new HttpError(403, "not the host of this room");
    if (what === "history") return json({ success: true, people: await seatedHistory(env, ids) }, 200, origin);
    if (await limited(env.WRITE_LIMITER, `room:${code}`)) throw new HttpError(429, "this room is sending too fast, try again in a minute");
    return json({ success: true, ...(await recordSeatedPlays(request, env, ids)) }, 200, origin);
  } catch (e){
    if (e instanceof HttpError) return json({ success: false, message: e.message }, e.status, origin);
    console.error("room host route failed", request.method, url.pathname, String(e?.message || e));
    return json({ success: false, message: "server error" }, 500, origin);
  }
}

export async function rooms(request, env, url){
  const originHeader = request.headers.get("origin");
  const origin = allowedOrigin(originHeader, env);
  // Browsers always send Origin on a WebSocket handshake and on a
  // cross-origin POST, so a missing or foreign one is not the game.
  if (!origin) return json({ success: false, message: "origin not allowed" }, 403, null);
  const ip = request.headers.get("cf-connecting-ip") || "local";
  if (url.pathname.startsWith("/api/rooms/")) return hostRoute(request, env, url, origin, ip);

  if (url.pathname === "/api/rooms"){
    // No body and no custom headers, so the browser sends it without a preflight.
    if (request.method !== "POST") return json({ success: false, message: "method not allowed" }, 405, origin);
    if (await limited(env.ROOM_CREATE_LIMITER, ip)) return json({ success: false, message: "too many new rooms from here, try again in a minute" }, 429, origin);
    const host = token();
    const hostHash = await sha256Hex(host);
    for (let i = 0; i < CLAIM_TRIES; i++){
      const code = randomCode();
      const stub = await getServerByName(env.Room, code);
      if (await stub.claim(hostHash, code)) return json({ success: true, code, host }, 201, origin);
    }
    return json({ success: false, message: "no free room code, try again" }, 503, origin);
  }

  const res = await routePartykitRequest(request, env, {
    onBeforeConnect: async (req, lobby) => {
      if (lobby.className !== "Room" || !CODE_RX.test(lobby.name)) return new Response("no such room", { status: 404 });
      if (await limited(env.ROOM_CONNECT_LIMITER, ip)) return new Response("too many connections, try again in a minute", { status: 429 });
    },
    // Rooms speak WebSocket only.
    onBeforeRequest: () => new Response("not found", { status: 404 }),
  });
  return res || json({ success: false, message: "not found" }, 404, origin);
}
