/* HTTP side of buzz-in rooms: making a room, and letting a WebSocket through
   to its Durable Object (src/room.js). */
import { getServerByName, routePartykitRequest } from "partyserver";
import { allowedOrigin } from "./group.js";
import { CODE_RX, randomCode } from "./room.js";

const CLAIM_TRIES = 6;

const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  vary: "Origin",
  ...(origin ? { "access-control-allow-origin": origin } : {}),
} });

async function limited(limiter, key){
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

const token = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function sha256Hex(s){
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, x => x.toString(16).padStart(2, "0")).join("");
}

export const isRoomPath = path => path === "/api/rooms" || path.startsWith("/parties/");

export async function rooms(request, env, url){
  const originHeader = request.headers.get("origin");
  const origin = allowedOrigin(originHeader, env);
  // Browsers always send Origin on a WebSocket handshake and on a
  // cross-origin POST, so a missing or foreign one is not the game.
  if (!origin) return json({ success: false, message: "origin not allowed" }, 403, null);
  const ip = request.headers.get("cf-connecting-ip") || "local";

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
