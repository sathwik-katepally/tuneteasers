/* Buzz-in rooms: one Durable Object per room code (PartyServer, WebSocket
   hibernation). The host screen runs the show and plays the audio; phones
   buzz and type answers. This object is the referee: it orders buzzes as
   they arrive, runs the answer timer, judges typed answers and keeps the
   scores. It learns each song's title from the host and never sends it to a
   phone before the reveal; it never sees a stream URL at all.
   Everything lives in this object's storage and is wiped when the room has
   been idle for ROOM_TTL_MS. Nothing is written to D1.
   A phone brings the song keys it has heard recently when it takes its seat;
   they are kept per seat and only the host gets them, merged, to leave those
   songs out of its crate. */
import { Server } from "partyserver";
import { isCorrect } from "../../src/lib/answer.js";
import { ROOM_HEARD } from "../../src/lib/constants.js";
import { songKey } from "../../src/lib/utils.js";

export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const CODE_RX = /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const KEY_RX = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_RX = /^[A-Za-z0-9_-]{22}$/;
const MIXES = ["bolly", "telugu", "both"];
const CONTROL_RX = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const HOUR = 3600e3;

const ROOM_TTL_MS = 3 * 3600e3;
const HELLO_MS = 10e3;
const LIMITS = {
  players: 16,
  connections: 48,
  name: 24,
  title: 120,
  guess: 80,
  near: 60,
  songs: 200,
  points: 1000,
  playerMsg: 1024,
  // A join carries the phone's heard songs (ROOM_HEARD), so it may be bigger.
  joinMsg: 32 * 1024,
  hostMsg: 64 * 1024,
  answerSecs: [5, 60],
};
// Per connection: a burst of 12 messages, refilled at 6 a second. A phone
// mashing the buzzer stays well inside this; a script does not.
const BUCKET = { size: 12, perSec: 6, strikes: 40 };

/* "Heard it too much" skips (docs/room-mode.md), from the Worker vars. */
function skipRules(env){
  const share = Number(env.ROOM_SKIP_VOTE_SHARE);
  const max = Number(env.ROOM_SKIPS_PER_SHOW);
  return {
    share: share > 0 && share < 1 ? share : 0.5,
    max: Number.isInteger(max) && max >= 0 ? max : 3,
  };
}
// Votes needed to skip: strictly more than `share` of the seated players.
const votesNeeded = (seated, share) => Math.floor(seated * share) + 1;

// A handler returns SAME when the message changed nothing (a late or repeated
// buzz), so a mashed button does not rewrite storage or fan out a state.
const SAME = Symbol("same");
const clean = (v, max) => (typeof v === "string" ? v.replace(CONTROL_RX, "").trim().slice(0, max) : "");
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function randomToken(bytes = 16){
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomCode(){
  const b = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(b, x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}
/* A phone's heard songs, { key: hours until it may come back }, to
   { key: time it may come back } on this room's clock. Anything malformed is
   dropped; past the cap the rest is ignored. null when there is no map. */
function cleanHeard(h){
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const now = Date.now(), out = new Map();
  for (const [k, v] of Object.entries(h)){
    if (out.size >= ROOM_HEARD.songs) break;
    if (!k || k.length > ROOM_HEARD.key || HAS_CONTROL.test(k) || !intIn(v, 1, ROOM_HEARD.hours)) continue;
    out.set(k, now + v * HOUR);
  }
  return Object.fromEntries(out);
}
const heardKey = seat => `heard:${seat}`;

async function hash(s){
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, x => x.toString(16).padStart(2, "0")).join("");
}

export class Room extends Server {
  static options = { hibernate: true };

  async onStart(){
    this.room = (await this.ctx.storage.get("room")) || null;
    this.buckets = new Map();
  }

  /* Admission happens at the upgrade, before any socket is accepted into the
     room: a code nobody claimed, or a room already at its connection cap, gets
     a socket that is closed at once with the reason, so a silent client can
     neither linger nor crowd out real players. (A close sent from onConnect
     never reaches the client, hence the separate throwaway socket.) */
  async fetch(request){
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket"){
      const room = this.room !== undefined ? this.room : (await this.ctx.storage.get("room")) || null;
      const refuse = !room || room.touchedAt <= Date.now() - ROOM_TTL_MS ? [4404, "no such room"]
        // A peer that never answers our close stays listed as closing; it holds no seat.
        : this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN).length >= LIMITS.connections ? [4429, "room is full"] : null;
      if (refuse){
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].close(...refuse);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
    }
    return super.fetch(request);
  }

  /* Called by the Worker's POST /api/rooms on a freshly drawn code. Sockets
     left from an expired room with the same code must not carry their roles
     into the new one. */
  async claim(hostHash, code){
    if (this.room && this.room.touchedAt > Date.now() - ROOM_TTL_MS) return false;
    for (const c of this.getConnections()) c.close(4410, "room closed");
    await this.ctx.storage.deleteAll();
    this.room = {
      code, hostHash, createdAt: Date.now(), touchedAt: Date.now(),
      phase: "lobby", players: [], rules: { answerSecs: 15 },
      mix: "both", total: 0, perRound: 1, song: null, results: [], skipped: [], seq: 0, skips: 0, cues: 0,
    };
    await this.save();
    return true;
  }

  async save(){
    this.room.touchedAt = Date.now();
    await this.ctx.storage.put("room", this.room);
    await this.arm();
  }

  async arm(){
    const r = this.room;
    if (!r) return;
    const at = [r.touchedAt + ROOM_TTL_MS];
    if (r.song?.deadline) at.push(r.song.deadline);
    for (const c of this.getConnections()) if (!c.state?.role) at.push((c.state?.at || Date.now()) + HELLO_MS);
    await this.ctx.storage.setAlarm(Math.min(...at));
  }

  onConnect(conn){
    conn.setState({ at: Date.now() });
    this.arm();
  }

  async onClose(conn){
    if (this.room && conn.state?.seat) this.broadcastState();
  }

  async onAlarm(){
    const r = this.room;
    if (!r) return;
    const now = Date.now();
    if (now >= r.touchedAt + ROOM_TTL_MS){
      for (const c of this.getConnections()) c.close(4410, "room closed");
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    for (const c of this.getConnections()) if (!c.state?.role && now - (c.state?.at || 0) >= HELLO_MS) c.close(4401, "no hello");
    const song = r.song;
    if (song?.state === "answering" && song.deadline && now >= song.deadline - 50){
      this.judge(song.answering, "", false);
      await this.save();
      this.broadcastState();
      return;
    }
    await this.arm();
  }

  allow(conn){
    const now = Date.now();
    const b = this.buckets.get(conn.id) || { tokens: BUCKET.size, at: now, strikes: 0 };
    b.tokens = Math.min(BUCKET.size, b.tokens + ((now - b.at) / 1000) * BUCKET.perSec);
    b.at = now;
    this.buckets.set(conn.id, b);
    if (b.tokens < 1){
      if (++b.strikes > BUCKET.strikes) conn.close(4429, "too many messages");
      return false;
    }
    b.tokens -= 1;
    return true;
  }

  async onMessage(conn, raw){
    if (!this.room){ conn.close(4404, "no such room"); return; }
    // Every frame is charged before anything else looks at it.
    if (!this.allow(conn)) return;
    const role = conn.state?.role;
    const hello = !role && typeof raw === "string" ? raw.slice(0, 11) : "";
    const max = role === "host" || hello === '{"t":"host"' ? LIMITS.hostMsg : hello === '{"t":"join"' ? LIMITS.joinMsg : LIMITS.playerMsg;
    const size = typeof raw === "string" ? raw.length : raw.byteLength ?? 0;
    // The app never sends a frame this big or a binary one, so the peer goes.
    if (size > max || typeof raw !== "string") return conn.close(1009, "message too big");
    let m;
    try { m = JSON.parse(raw); } catch { return this.fail(conn, "bad-json"); }
    if (!m || typeof m !== "object" || typeof m.t !== "string") return this.fail(conn, "bad-message");

    if (!role){
      if (m.t === "host") return this.helloHost(conn, m);
      if (m.t === "join") return this.helloPlayer(conn, m);
      return this.fail(conn, "hello-first");
    }
    const handler = role === "host" ? HOST[m.t] : PLAYER[m.t];
    if (!handler) return this.fail(conn, "unknown");
    const err = handler.call(this, conn, m);
    if (err === SAME) return;
    if (err) return this.fail(conn, err);
    await this.save();
    if (m.t === "kick" || m.t === "leave") await this.dropHeard();
    this.broadcastState();
  }

  fail(conn, code){
    conn.send(JSON.stringify({ t: "error", code }));
  }

  async helloHost(conn, m){
    if (!TOKEN_RX.test(m.token || "") || (await hash(m.token)) !== this.room.hostHash) return conn.close(4403, "not the host");
    conn.setState({ role: "host" });
    conn.send(JSON.stringify({ t: "welcome", role: "host", code: this.room.code }));
    conn.send(JSON.stringify(this.view(null)));
    conn.send(JSON.stringify(await this.heard()));
    await this.arm();
  }

  async helloPlayer(conn, m){
    const r = this.room;
    if (!KEY_RX.test(m.key || "")) return this.fail(conn, "bad-key");
    const keyHash = await hash(m.key);
    let p = r.players.find(x => x.keyHash === keyHash);
    if (!p){
      const name = clean(m.name, LIMITS.name);
      if (!name) return this.fail(conn, "name");
      if (r.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return this.fail(conn, "name-taken");
      if (r.players.length >= LIMITS.players) return this.fail(conn, "full");
      p = { id: randomToken(6), keyHash, name, score: 0 };
      r.players.push(p);
      await this.save();
    }
    // Every hello brings the phone's history as it is now; one without any
    // keeps what the seat brought before.
    const heard = cleanHeard(m.heard);
    if (heard){
      await this.ctx.storage.put(heardKey(p.id), heard);
      await this.sendHeard();
    }
    conn.setState({ role: "player", seat: p.id });
    conn.send(JSON.stringify({ t: "welcome", role: "player", code: r.code, seat: p.id, name: p.name }));
    this.broadcastState();
  }

  /* For the host only: every seated phone's heard songs merged, as
     { key: [hours until it may come back, how many seats heard it] }.
     Seated means with a seat, online or not, as for skip votes. */
  async heard(){
    const r = this.room, now = Date.now();
    const got = r.players.length ? await this.ctx.storage.get(r.players.map(p => heardKey(p.id))) : new Map();
    const songs = new Map();
    for (const h of got.values()){
      for (const [k, at] of Object.entries(h || {})){
        if (!(at > now)) continue;
        const [hours, n] = songs.get(k) || [0, 0];
        songs.set(k, [Math.max(hours, Math.ceil((at - now) / HOUR)), n + 1]);
      }
    }
    return { t: "heard", songs: Object.fromEntries(songs) };
  }

  async sendHeard(){
    const hosts = [...this.getConnections()].filter(c => c.state?.role === "host");
    if (!hosts.length) return;
    const m = JSON.stringify(await this.heard());
    for (const c of hosts) c.send(m);
  }

  /* A seat that is gone (kicked, or left the lobby) takes its songs with it. */
  async dropHeard(){
    const seats = new Set(this.room.players.map(p => heardKey(p.id)));
    const stale = [...(await this.ctx.storage.list({ prefix: "heard:" })).keys()].filter(k => !seats.has(k));
    if (!stale.length) return;
    await this.ctx.storage.delete(stale);
    await this.sendHeard();
  }

  online(){
    const on = new Set();
    for (const c of this.getConnections()) if (c.state?.seat) on.add(c.state.seat);
    return on;
  }

  /* What one connection may see. The answer is only in it once revealed. */
  view(seat){
    const r = this.room;
    const on = this.online();
    const s = r.song;
    const rules = skipRules(this.env);
    return {
      t: "state",
      phase: r.phase,
      code: r.code,
      mix: r.mix,
      total: r.total,
      perRound: r.perRound,
      answerSecs: r.rules.answerSecs,
      players: r.players.map(p => ({ id: p.id, name: p.name, score: p.score, online: on.has(p.id) })),
      results: r.results,
      skipped: (r.skipped || []).map(x => ({ key: x.key, tired: x.voters.includes(seat) })),
      seq: r.seq,
      skips: { used: r.skips || 0, max: rules.max },
      song: s && {
        n: s.n, cue: s.cue ?? 0, rung: s.rung, points: s.points, state: s.state,
        queue: s.queue.map(q => q.id), locked: s.locked, answering: s.answering,
        msLeft: s.deadline ? Math.max(0, s.deadline - Date.now()) : null,
        guesses: s.guesses, winner: s.winner, won: s.won,
        answer: s.state === "revealed" ? s.answer : null,
        votes: s.votes || [], votesNeeded: votesNeeded(r.players.length, rules.share),
      },
      me: seat,
    };
  }

  broadcastState(){
    for (const c of this.getConnections()){
      const role = c.state?.role;
      if (role === "host") c.send(JSON.stringify(this.view(null)));
      else if (role === "player") c.send(JSON.stringify(this.view(c.state.seat)));
    }
  }

  /* One answer from the player at the head of the queue: right ends the song,
     wrong (or out of time) locks them out and hands over to the next buzzer. */
  judge(seat, text, ok){
    const r = this.room, s = r.song;
    const entry = s.queue.find(q => q.id === seat);
    s.queue = s.queue.filter(q => q.id !== seat);
    s.guesses.push({ id: seat, text, ok, timeout: !text });
    r.seq++;
    if (ok){
      const p = r.players.find(x => x.id === seat);
      const pts = entry?.points ?? s.points;
      if (p) p.score += pts;
      s.winner = seat; s.won = pts;
      this.finishSong();
      return;
    }
    s.locked.push(seat);
    this.nextAnswerer();
  }

  nextAnswerer(){
    const s = this.room.song;
    const next = s.queue[0];
    if (next){
      s.answering = next.id;
      s.deadline = Date.now() + this.room.rules.answerSecs * 1000;
      s.state = "answering";
    } else {
      s.answering = null;
      s.deadline = null;
      s.state = "missed";
    }
  }

  /* "Heard it too much": song n is dropped without a result or a reveal and
     the host re-cues n with another song. The title stays in this object;
     phones get only its song key, after the skip (the big screen shows the
     title then anyway), to keep it out of their own next crates: as tired
     for those who voted, as played for everyone else. */
  skipSong(){
    const r = this.room, s = r.song;
    r.skips = (r.skips || 0) + 1;
    (r.skipped ||= []).push({ key: songKey(s.answer.title), voters: s.votes || [] });
    r.song = { n: s.n, cue: s.cue, rung: -1, points: 0, state: "skipped", answer: null,
      queue: [], locked: [], answering: null, deadline: null, guesses: [], winner: null, won: 0, near: [], votes: [] };
    r.seq++;
  }

  /* Votes open once the clip is playing (nobody can know the song before),
     until anyone buzzes. `cue` names the song a vote or skip was meant for,
     so one that arrives after a re-cue can't skip the replacement. */
  canSkip(cue){
    const r = this.room, s = r.song;
    if (!s || cue !== s.cue) return "stale";
    if (s.state !== "live" || s.queue.length || s.guesses.length) return "not-now";
    if ((r.skips || 0) >= skipRules(this.env).max) return "no-skips";
    return null;
  }

  finishSong(){
    const r = this.room, s = r.song;
    s.state = "revealed";
    s.answering = null;
    s.deadline = null;
    s.queue = [];
    r.results.push({ n: s.n, title: s.answer.title, winner: s.winner, points: s.won });
    r.seq++;
  }
}

const HOST = {
  start(conn, m){
    const r = this.room;
    if (r.phase === "show") return "already-started";
    if (!MIXES.includes(m.mix)) return "bad-mix";
    if (!intIn(m.total, 1, LIMITS.songs) || !intIn(m.perRound, 1, LIMITS.songs)) return "bad-length";
    if (!intIn(m.answerSecs, ...LIMITS.answerSecs)) return "bad-rules";
    if (!r.players.length) return "no-players";
    r.phase = "show";
    r.mix = m.mix;
    r.total = m.total;
    r.perRound = m.perRound;
    r.rules = { answerSecs: m.answerSecs };
    r.song = null;
    r.results = [];
    r.skipped = [];
    r.skips = 0;
    for (const p of r.players) p.score = 0;
    r.seq++;
  },
  song(conn, m){
    const r = this.room;
    if (r.phase !== "show") return "not-started";
    const title = clean(m.title, LIMITS.title);
    if (!title || !intIn(m.n, 1, LIMITS.songs)) return "bad-song";
    // Song n can only follow n-1's result and never passes the show's length,
    // so a host that re-cues (a resume, a skip) can't replay a scored song.
    if (m.n !== r.results.length + 1 || m.n > r.total) return "bad-song-number";
    if (!Array.isArray(m.near) || m.near.length > LIMITS.near) return "bad-song";
    // Every cue, a re-cue of the same n included, gets its own id.
    r.cues = (r.cues || 0) + 1;
    r.song = {
      n: m.n, cue: r.cues, rung: -1, points: 0, state: "cue",
      answer: { title, film: clean(m.film, LIMITS.title), year: intIn(m.year, 0, 3000) ? m.year : 0, artist: clean(m.artist, LIMITS.title) },
      queue: [], locked: [], answering: null, deadline: null, guesses: [], winner: null, won: 0, votes: [],
      // Other titles that fold close to this one: judging only, never in a view.
      near: m.near.map(t => clean(t, LIMITS.title)).filter(Boolean),
    };
  },
  /* A clip (rung) has started playing: buzzing opens at its points. */
  clip(conn, m){
    const s = this.room.song;
    if (!s || !intIn(m.rung, 0, 20) || !intIn(m.points, 0, LIMITS.points)) return "bad-clip";
    if (s.state === "answering" || s.state === "revealed" || s.state === "skipped") return "busy";
    s.rung = m.rung;
    s.points = m.points;
    s.state = "live";
  },
  /* The host skips straight away, no vote needed; it still counts toward the cap. */
  skip(conn, m){
    const err = this.canSkip(m.cue);
    if (err) return err;
    this.skipSong();
  },
  reveal(){
    const s = this.room.song;
    if (!s || s.state === "revealed" || s.state === "skipped") return SAME;
    s.winner = null; s.won = 0;
    this.finishSong();
  },
  end(){
    const r = this.room;
    if (r.song && r.song.state !== "revealed" && r.song.state !== "skipped") this.finishSong();
    r.phase = "over";
  },
  kick(conn, m){
    const r = this.room;
    if (r.phase !== "lobby") return "not-lobby";
    const p = r.players.find(x => x.id === m.id);
    if (!p) return SAME;
    r.players = r.players.filter(x => x !== p);
    for (const c of this.getConnections()) if (c.state?.seat === p.id) c.close(4403, "removed by host");
  },
};

const PLAYER = {
  buzz(conn){
    const r = this.room, s = r.song, me = conn.state.seat;
    // "missed" is the beat after a wrong answer before more of the song plays;
    // someone the wrong guess just jogged can still buzz in at the same points.
    if (!s || (s.state !== "live" && s.state !== "answering" && s.state !== "missed")) return SAME;
    if (s.locked.includes(me) || s.queue.some(q => q.id === me)) return SAME;
    s.queue.push({ id: me, points: s.points });
    r.seq++;
    if (s.state !== "answering") this.nextAnswerer();
  },
  /* "Heard it too much". Only the tally and who voted are in a view. */
  vote(conn, m){
    const r = this.room, s = r.song, me = conn.state.seat;
    if (this.canSkip(m.cue)) return SAME;
    s.votes ||= [];
    if (s.votes.includes(me)) return SAME;
    s.votes.push(me);
    r.seq++;
    if (s.votes.length >= votesNeeded(r.players.length, skipRules(this.env).share)) this.skipSong();
  },
  answer(conn, m){
    const r = this.room, s = r.song, me = conn.state.seat;
    if (!s || s.state !== "answering" || s.answering !== me) return "not-your-turn";
    const text = clean(m.text, LIMITS.guess);
    if (!text) return "empty";
    // The alarm is at-least-once and may run late; the clock is the rule.
    if (s.deadline && Date.now() > s.deadline) return void this.judge(me, "", false);
    this.judge(me, text, isCorrect(text, s.answer.title, s.near));
  },
  leave(conn){
    const r = this.room, me = conn.state.seat;
    if (r.phase === "lobby") r.players = r.players.filter(p => p.id !== me);
    conn.setState({ at: Date.now() });
    conn.close(1000, "left");
  },
};
