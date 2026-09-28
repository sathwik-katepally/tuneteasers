/* A buzz-in room the way a party plays it: desktop Chromium is the host
   screen and three WebKit iPhones (separate contexts) are the buzzers.
   The deployed Worker host is rerouted to a local `wrangler dev` (started
   here) or to --worker=<origin>; room WebSockets go through a proxy in this
   script, which also records every frame each phone receives. Checks:
   - joining by code (typed) and by the #room link,
   - a buzz race is answered in the order buzzes reached the room,
   - a wrong answer passes to the next buzzer, a right one scores the rung,
   - nobody knowing carries the clip ladder on (manual and automatic), on
     the difficulty's own ladder (Music-only has one rung fewer),
   - the answer timer runs out, and everyone locked out reveals the song,
   - a phone that reloads mid-show keeps its seat and score,
   - the podium matches the room, and every phone's final place does too,
   - "Heard it too much": one vote of three does not skip, a majority does,
     the host can skip on its own, the room stops at its skip cap, votes
     close once someone buzzes, and a skipped title never reaches a phone,
   - no phone ever receives the title before its reveal, or any stream URL.
   node e2e/room.mjs [--host=phone] [--difficulty=easy|medium|hard] [--categories=item,mass] [--phone-engine=chromium] [--worker=https://...] [--shots=dir] */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { serve, args, localWorker, silence, skipLanding, MUTE_ARGS } from "./harness.mjs";
import { displayTitle } from "../src/lib/utils.js";
import { CATEGORIES, DIFFICULTY, ROOM_ANSWER_SECS, ladderFor } from "../src/lib/config.ts";
import { songKey } from "../src/lib/utils.js";

const A = args({ difficulty: "easy" });
const LADDER = ladderFor(DIFFICULTY[A.difficulty]?.sound === "full");
const CLIP_POINTS = LADDER.points;
const categories = A.categories ? A.categories.split(",") : [];
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";

const worker = A.worker ? { origin: A.worker.replace(/\/$/, ""), stop(){} } : await localWorker();
const server = await serve();
const url = server.url;
const origin = new URL(url).origin;
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const traffic = {}; // label -> [{ at, dir, data }]
const latest = {};  // label -> last room state that label received
let buzzLog = [];   // [label] in the order buzz frames were forwarded to the room

async function wire(context, label){
  await context.route(u => u.host === WORKER_HOST, async route => {
    const u = new URL(route.request().url());
    try {
      const res = await route.fetch({ url: worker.origin + u.pathname + u.search });
      return route.fulfill({ response: res });
    } catch { return route.abort(); }
  });
  await context.routeWebSocket(u => u.host === WORKER_HOST, ws => {
    const u = new URL(ws.url());
    const up = new WebSocket(worker.origin.replace(/^http/, "ws") + u.pathname + u.search, { headers: { origin } });
    const pending = [];
    const log = traffic[label] ||= [];
    up.onopen = () => { for (const m of pending.splice(0)) up.send(m); };
    up.onmessage = e => {
      const data = String(e.data);
      log.push({ at: Date.now(), dir: "in", data });
      try { const m = JSON.parse(data); if (m.t === "state") latest[label] = m; } catch {}
      ws.send(data);
    };
    up.onclose = e => { try { ws.close({ code: e.code >= 4000 ? e.code : 1000, reason: e.reason }); } catch {} };
    ws.onMessage(m => {
      const data = String(m);
      log.push({ at: Date.now(), dir: "out", data });
      if (data.includes('"t":"buzz"')) buzzLog.push(label);
      if (up.readyState === 1) up.send(data); else pending.push(data);
    });
    ws.onClose(() => { try { up.close(); } catch {} });
  });
}

// --host=phone runs the host screen on a WebKit iPhone too (a room with no laptop).
const hostOnPhone = A.host === "phone";
async function device(kind, label){
  const desk = kind === "host" && !hostOnPhone;
  const browser = desk
    ? await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] })
    : await (A["phone-engine"] === "chromium" ? chromium : webkit).launch();
  const context = await browser.newContext(desk
    ? { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }
    : { ...devices["iPhone 13"], reducedMotion: "reduce" });
  await wire(context, label);
  await context.addInitScript(silence);
  await context.addInitScript(skipLanding);
  // Counts what actually reached the page, to tell a lost frame from an app bug.
  await context.addInitScript(() => {
    const W = window.WebSocket;
    window.__rx = { n: 0, last: "", opened: 0 };
    window.WebSocket = class extends W {
      constructor(...a){
        super(...a);
        window.__rx.opened++;
        this.addEventListener("message", e => { window.__rx.n++; window.__rx.last = String(e.data).slice(0, 300); });
      }
    };
  });
  const page = await context.newPage();
  const errors = [], logs = [];
  page.on("console", m => { if (m.text().startsWith("[tt]")) logs.push(m.text()); });
  page.on("pageerror", e => errors.push(`${label}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  return { label, browser, context, page, errors, logs };
}

// Every in-show screen has to fit without scrolling; setup and the lobby may scroll.
const overflow = [];
async function shot(dev, name){
  await dev.page.waitForTimeout(400);
  const spill = await dev.page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  if (spill > 1 && !/setup|lobby|join/.test(name)) overflow.push(`${name}+${spill}px`);
  if (shotsDir) await dev.page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

async function until(what, fn, timeout = 30000){
  const t0 = Date.now();
  for (;;){
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const hostState = () => latest.host;
const song = () => latest.host?.song;
const idOf = name => latest.host.players.find(p => p.name === name)?.id;
const nameOf = id => latest.host.players.find(p => p.id === id)?.name;
const scoreOf = name => latest.host.players.find(p => p.name === name)?.score;
const hostShow = () => host.page.evaluate(() => JSON.parse(localStorage.getItem("tt_room_host") || "null"));
async function currentTitle(){
  const s = await hostShow();
  return s.queue[s.idx].title;
}
// A wrong guess comes from the public list and is never a song in this show:
// a guess is echoed to every phone, and the secrecy check must only catch the
// room leaking titles, not a player saying one.
const publicTitles = (() => {
  const corpus = JSON.parse(fs.readFileSync(new URL("../dist/corpus.json", import.meta.url), "utf8"));
  const iTitle = corpus.cols.indexOf("title");
  return corpus.songs.map(r => displayTitle(r[iTitle]));
})();
async function wrongTitle(){
  const s = await hostShow();
  const inShow = new Set(s.queue.map(t => songKey(t.title)));
  return publicTitles.find(t => !inShow.has(songKey(t)) && t.length > 6);
}

const buzzBtn = p => p.page.locator('button[aria-label="Buzz"]');
// A tap that lands just as buzzing closes (the song was revealed) is rightly
// ignored, so a buzz counts once the room has the phone in its queue.
async function buzz(p){
  const inRoom = () => { const s = song(), id = idOf(p.label); return s && (s.answering === id || s.queue.includes(id)); };
  const t0 = Date.now();
  for (;;){
    if (inRoom()) return;
    await buzzBtn(p).waitFor({ timeout: 20000 }).catch(() => {});
    await buzzBtn(p).click({ timeout: 2000 }).catch(() => {});
    for (let i = 0; i < 10 && !inRoom(); i++) await sleep(100);
    if (inRoom()) return;
    if (Date.now() - t0 > 20000) fail(`${p.label}'s buzz never reached the room`);
  }
}

async function answer(p, text, { pick = true } = {}){
  const input = p.page.getByLabel("Your answer");
  await p.page.getByRole("button", { name: "Lock it in" }).waitFor({ timeout: 10000 });
  await input.fill(text.slice(0, Math.max(4, Math.ceil(text.length * 0.6))));
  const option = p.page.getByRole("option", { name: text, exact: true });
  if (pick && await option.count()) await option.first().click();
  else { await input.fill(text); await p.page.getByRole("button", { name: "Lock it in" }).click(); }
}

/* Waits for the host to have a live clip at `rung` for song `n`. */
// A stream that won't start gets skipped the way a host would; the room
// keeps the song number and takes the next title.
let deadStreams = 0;
const live = (n, rung) => until(`song ${n} live at rung ${rung}`, async () => {
  if (song()?.n === n && song().state === "live" && song().rung === rung) return true;
  const skip = host.page.getByRole("button", { name: "Skip this song" });
  if (rung === 0 && await skip.isVisible().catch(() => false)){
    if (++deadStreams > 2) fail("three dead streams");
    await skip.click({ timeout: 1500 }).catch(() => {});
  }
  return false;
}, 45000);

async function nextSong(n){
  const next = host.page.getByRole("button", { name: /Next song|box office|On to round/ });
  await until(`song ${n} cued`, async () => {
    if (song()?.n === n) return true;
    if (await next.count() && await next.first().isEnabled({ timeout: 500 }).catch(() => false)) await next.first().click({ timeout: 1500 }).catch(() => {});
    return false;
  });
}

async function revealed(n){
  await until(`song ${n} revealed`, () => song()?.n === n && song().state === "revealed");
  await host.page.getByRole("button", { name: /Next song|box office/ }).first().waitFor({ timeout: 20000 });
}

/* The room refuses what the app never sends: foreign origins, unknown rooms,
   silent sockets, a phone playing host, oversized frames, frames before a
   hello, floods, and song numbers out of order. Runs while the second show's
   first song is live. */
async function guards(code, hostToken, total){
  const wsBase = worker.origin.replace(/^http/, "ws") + "/parties/room/";
  const connect = (c, o = origin) => new Promise(res => {
    const ws = new WebSocket(wsBase + c, { headers: { origin: o } });
    const got = [];
    const conn = { ws, got, open: false, code: 0 };
    ws.onmessage = e => got.push(JSON.parse(String(e.data)));
    conn.closed = new Promise(r => { ws.onclose = e => { conn.code = e.code; r(e.code); }; });
    ws.onopen = () => { conn.open = true; res(conn); };
    ws.onerror = () => res(conn);
  });
  const closedWith = (c, ms = 3000) => Promise.race([c.closed, sleep(ms).then(() => 0)]);

  const bad = await connect(code, "https://evil.example");
  if (bad.open) fail("a foreign origin opened a room socket");
  const post = await fetch(worker.origin + "/api/rooms", { method: "POST", headers: { origin: "https://evil.example" } });
  if (post.status !== 403) fail(`a foreign origin made a room (${post.status})`);

  // An unclaimed code is refused at the upgrade, even from a socket that never speaks.
  const none = await connect(code === "BBBB" ? "CCCC" : "BBBB");
  if ((await closedWith(none)) !== 4404) fail(`an unknown room code was not closed with 4404 (${none.code})`);

  const fake = await connect(code);
  fake.ws.send(JSON.stringify({ t: "host", token: "A".repeat(22) }));
  if ((await closedWith(fake)) !== 4403) fail("a wrong host token was not refused");

  // Silent sockets fill the room only up to its cap, and the hello timeout
  // clears them. This runs in a real browser: Node's WebSocket never finishes
  // a close the server starts, so it would never report the 4401.
  // Its own context: the game contexts reroute the Worker's host through this
  // script's proxy, whose Node upstream reports a close the server starts
  // about 10 s late, so against the production host the probe would time out
  // before the 4401 reached the page.
  const probeContext = await host.browser.newContext();
  const probe = await probeContext.newPage();
  await probe.goto(url + "seed.html");
  // Sockets open one after another; a refused one still opens (the refusal is
  // a close right after the upgrade), so each is classified only once the
  // network has had time to deliver that close.
  const silent = await probe.evaluate(async ({ url, max }) => {
    const socks = [];
    for (let i = 0; i < max; i++){
      const s = await new Promise(res => {
        const ws = new WebSocket(url);
        const s = { ws, code: 0, open: false, at: 0 };
        s.closed = new Promise(r => ws.addEventListener("close", e => { s.code = e.code; s.at = Date.now(); r(e.code); }));
        ws.addEventListener("open", () => { s.open = true; res(s); });
        ws.addEventListener("error", () => res(s));
      });
      if (!s.open) return { error: `socket ${i} failed to open` };
      socks.push(s);
    }
    await new Promise(r => setTimeout(r, 3000));
    // Over a real network the first admitted sockets may already have hit
    // the 10 s hello timeout by now; they count as admitted.
    const refused = socks.filter(s => s.code === 4429);
    const admitted = socks.filter(s => !s.code || s.code === 4401);
    if (refused.length + admitted.length !== socks.length) return { error: `unexpected closes: ${[...new Set(socks.map(s => s.code))]}` };
    const codes = await Promise.all(admitted.map(s => Promise.race([s.closed, new Promise(r => setTimeout(() => r(0), 16000))])));
    return { admitted: admitted.length, refused: refused.length, codes: [...new Set(codes)] };
  }, { url: wsBase + code, max: 60 });
  await probeContext.close();
  if (silent.error) fail(silent.error);
  if (!silent.refused || silent.admitted < 40 || silent.admitted >= 60) fail(`the connection cap let ${silent.admitted} silent sockets in`);
  if (silent.codes.join() !== "4401") fail(`silent sockets were not timed out: ${silent.codes}`);

  const early = await connect(code);
  early.ws.send(JSON.stringify({ t: "buzz" }));
  await sleep(300);
  if (!early.got.some(m => m.code === "hello-first")) fail("a buzz before hello was not refused");
  early.ws.send(JSON.stringify({ t: "join", key: "g".repeat(24), name: "Guard" }));
  await sleep(300);
  early.ws.send(JSON.stringify({ t: "end" }));
  await sleep(300);
  if (!early.got.some(m => m.code === "unknown")) fail("a phone could send a host command");
  if (hostState().phase === "over") fail("a phone ended the show");
  early.ws.send(JSON.stringify({ t: "answer", text: "x".repeat(2000) }));
  if ((await closedWith(early)) !== 1009) fail(`an oversized frame did not close the socket (${early.code})`);

  const flood = await connect(code);
  flood.ws.send(JSON.stringify({ t: "join", key: "f".repeat(24), name: "Flood" }));
  await sleep(300);
  for (let i = 0; i < 80 && flood.ws.readyState === 1; i++) flood.ws.send(JSON.stringify({ t: "buzz" }));
  if ((await closedWith(flood)) !== 4429) fail(`a flood did not close the socket (${flood.code})`);

  // Song numbers only move forward one at a time and stop at the show's length.
  const h = await connect(code);
  h.ws.send(JSON.stringify({ t: "host", token: hostToken }));
  await sleep(300);
  const n = hostState().results.length + 1;
  for (const bad of [n + 1, total + 1]){
    h.got.length = 0;
    h.ws.send(JSON.stringify({ t: "song", n: bad, title: "Probe", near: [] }));
    await sleep(300);
    if (!h.got.some(m => m.code === "bad-song-number")) fail(`song ${bad} was accepted with ${n - 1} results`);
  }
  if (song().n !== n || song().answer) fail("a refused song number changed the room");
  // Someone has buzzed on this song, so it can no longer be skipped.
  h.got.length = 0;
  h.ws.send(JSON.stringify({ t: "skip", cue: song().cue }));
  await sleep(300);
  if (!h.got.some(m => m.code === "not-now")) fail("the room skipped a song after a buzz");
  for (const c of [bad, none, fake, h]) try { c.ws.close(); } catch {}
}

const host = await device("host", "host");
const phones = await Promise.all(["Asha", "Ravi", "Meena"].map(n => device("phone", n)));
const [asha, ravi, meena] = phones;
const all = [host, ...phones];
let exit = 0;
try {
  // Host opens a room.
  await host.page.goto(url + "seed.html");
  await host.page.evaluate(() => localStorage.clear());
  await host.page.goto(url);
  await host.page.getByRole("radio", { name: "Buzz in" }).click();
  await host.page.getByRole("radio", { name: DIFFICULTY[A.difficulty].label, exact: true }).click();
  await host.page.getByRole("radio", { name: "3", exact: true }).click();
  // --categories=item,mass: the room's crate must honour the home screen's song categories.
  for (const id of categories){
    const label = CATEGORIES.find(c => c.id === id)?.label ?? fail(`unknown category ${id}`);
    await host.page.getByRole("button", { name: new RegExp(`^${label}, \\d+ songs$`) }).click();
  }
  await shot(host, "host-01-setup");
  await host.page.getByRole("button", { name: "Open a room" }).click();
  await host.page.getByText("Doors open").waitFor({ timeout: 20000 });
  const code = (await hostShow()).code;
  if (!/^[A-Z]{4}$/.test(code)) fail(`bad room code ${code}`);
  await host.page.getByRole("img", { name: "QR code to join this room" }).waitFor();
  await shot(host, "host-02-lobby-empty");

  // Asha types the code on the home screen; Ravi and Meena open the link.
  await asha.page.goto(url);
  await asha.page.getByRole("button", { name: "Join with a code" }).click();
  await shot(asha, "phone-01-join-empty");
  await asha.page.getByLabel("Room code").fill(code.toLowerCase());
  await asha.page.getByLabel("Your name").fill("Asha");
  await asha.page.getByRole("button", { name: "Join the show" }).click();
  await asha.page.getByText("You're in").waitFor({ timeout: 15000 });
  if ((await asha.page.evaluate(() => location.hash)) !== `#room=${code}`) fail("room link not kept in the address bar");
  for (const p of [ravi, meena]){
    await p.page.goto(url + "#room=" + code);
    if ((await p.page.getByLabel("Room code").inputValue()) !== code) fail("room link did not fill the code");
    await p.page.getByLabel("Your name").fill(p.label);
    if (p === ravi) await shot(ravi, "phone-02-join-filled");
    await p.page.getByRole("button", { name: "Join the show" }).click();
    await p.page.getByText("You're in").waitFor({ timeout: 15000 });
  }
  // A duplicate name is refused on the phone, not on the big screen.
  const dup = await device("phone", "dup");
  await dup.page.goto(url + "#room=" + code);
  await dup.page.getByLabel("Your name").fill("asha");
  await dup.page.getByRole("button", { name: "Join the show" }).click();
  await dup.page.getByText("already has that name").waitFor({ timeout: 10000 });
  await dup.browser.close();
  await until("three players in the lobby", () => hostState()?.players.length === 3 && hostState().players.every(p => p.online));
  await host.page.getByText("3 in").waitFor();
  await shot(host, "host-03-lobby-full");
  await shot(meena, "phone-03-waiting");

  await host.page.getByRole("button", { name: "Start the show" }).click();
  const show = await until("host queue", async () => { const s = await hostShow(); return s?.started && s.queue.length ? s : null; });
  if (categories.length){
    const corpus = JSON.parse(fs.readFileSync(new URL("../dist/corpus.json", import.meta.url), "utf8"));
    const lang = { hindi: "bolly", telugu: "telugu" };
    const tags = new Map(corpus.songs.map(r => Object.fromEntries(corpus.cols.map((c, i) => [c, r[i]])))
      .map(r => [`${lang[r.language]}|${songKey(r.title)}`, r.tags]));
    for (const t of show.queue.slice(0, show.total)){
      const tt = tags.get(`${t.lang}|${songKey(t.title)}`);
      if (!tt?.some(x => categories.includes(x))) fail(`"${t.title}" is not tagged ${categories}`);
    }
  }

  // Song 1: a buzz race. Ravi, then Asha, then Meena; Ravi answers wrong,
  // Asha right at the rung she buzzed on.
  await live(1, 0);
  await shot(host, "host-04-playing");
  await shot(asha, "phone-04-buzzer-live");
  buzzLog = [];
  // The proxy's forwarding order stands in for arrival order. Across the
  // internet separate connections jitter by tens of milliseconds, so a
  // deployed Worker gets wider gaps.
  const gap = A.worker ? 500 : 70;
  await Promise.all([buzz(ravi), sleep(gap).then(() => buzz(asha)), sleep(gap * 2).then(() => buzz(meena))]);
  await until("three in the queue", () => song().queue.length === 3);
  const order = song().queue.map(nameOf);
  if (order.join() !== buzzLog.join()) fail(`buzz order ${order} differs from arrival order ${buzzLog}`);
  if (song().answering !== idOf(order[0])) fail("first buzz is not answering");
  const [first, second, third] = order.map(n => phones.find(p => p.label === n));
  await first.page.getByRole("button", { name: "Lock it in" }).waitFor();
  await host.page.getByText("On the buzzer").waitFor();
  await shot(host, "host-05-answering");
  await shot(first, "phone-05-answer-pad");
  await shot(second, "phone-06-in-line");
  await answer(first, await wrongTitle());
  await until("second buzzer answering", () => song().answering === idOf(second.label));
  await shot(first, "phone-07-locked-out");
  await shot(host, "host-06-wrong");
  const title1 = displayTitle(await currentTitle());
  // The phone's suggestions come from the public list it loaded itself.
  if (publicTitles.some(t => songKey(t) === songKey(title1))){
    await second.page.getByLabel("Your answer").fill(title1.slice(0, Math.max(4, Math.ceil(title1.length * 0.6))));
    await second.page.getByRole("option", { name: title1, exact: true }).first().waitFor({ timeout: 5000 });
    await shot(second, "phone-05b-suggestions");
  }
  await answer(second, title1);
  await revealed(1);
  if (scoreOf(second.label) !== CLIP_POINTS[0]) fail(`right answer on rung 0 scored ${scoreOf(second.label)}, not ${CLIP_POINTS[0]}`);
  if (scoreOf(first.label) !== 0 || scoreOf(third.label) !== 0) fail("someone else scored on song 1");
  await second.page.getByText("You got it").waitFor();
  await shot(second, "phone-08-won");
  await shot(third, "phone-09-reveal-other");
  await shot(host, "host-07-reveal");

  // Song 2: nobody buzzes, the host asks for more; a wrong answer with nobody
  // queued behind it carries the ladder on by itself (on Music-only's last
  // rung the cut clip replays from the top); then a right one.
  await nextSong(2);
  await live(2, 0);
  const more = host.page.getByRole("button", { name: /^Hear \d+s more$/ });
  await until("first clip over", () => host.page.getByText(/^Anyone\?/).isVisible());
  await shot(host, "host-08-grace");
  await more.click();
  await live(2, 1);
  await buzz(meena);
  await until("meena answering", () => song().answering === idOf("Meena"));
  await answer(meena, await wrongTitle());
  const after = Math.min(2, LADDER.last);
  await until("song 2 missed", () => song().state === "missed" || (after > 1 && song().rung === after));
  await live(2, after);
  await shot(meena, "phone-10-out-next-rung");
  await buzz(asha);
  await answer(asha, (await currentTitle()).toLowerCase().replace(/aa/g, "a"), { pick: false });
  await revealed(2);
  const ashaAfter2 = (first.label === "Asha" ? 0 : second.label === "Asha" ? CLIP_POINTS[0] : 0) + CLIP_POINTS[after];
  if (scoreOf("Asha") !== ashaAfter2) fail(`Asha has ${scoreOf("Asha")}, expected ${ashaAfter2} (typed answer at rung ${after})`);

  // Song 3: Ravi's phone reloads mid-show and gets its seat back, then the
  // answer clock runs out on Ravi and Meena answers.
  await nextSong(3);
  await live(3, 0);
  const raviId = idOf("Ravi"), raviScore = scoreOf("Ravi");
  await ravi.page.reload();
  await until("ravi back online", () => hostState().players.find(p => p.id === raviId)?.online && hostState().players.length === 3);
  await ravi.page.locator('button[aria-label="Buzz"]').waitFor({ timeout: 15000 });
  if (scoreOf("Ravi") !== raviScore || idOf("Ravi") !== raviId) fail("reloaded phone lost its seat or score");
  // Then leaves the site entirely and comes back through the room link.
  // (Navigating away rather than closing the tab: WebKit crashes closing a page with a routed WebSocket.)
  await ravi.page.goto(url + "seed.html");
  await until("ravi gone", () => !hostState().players.find(p => p.id === raviId)?.online);
  await ravi.page.goto(url + "#room=" + code);
  await ravi.page.locator('button[aria-label="Buzz"], button[aria-label*="answering"], button[aria-label*="Wait"]').first().waitFor({ timeout: 15000 });
  if (hostState().players.length !== 3 || idOf("Ravi") !== raviId) fail("reopened phone took a new seat");
  await buzz(ravi);
  await until("ravi answering", () => song().answering === raviId);
  await buzz(meena);
  const t0 = Date.now();
  await until("ravi timed out", () => song().answering === idOf("Meena"), (ROOM_ANSWER_SECS + 5) * 1000);
  const waited = (Date.now() - t0) / 1000;
  if (waited < ROOM_ANSWER_SECS - 2) fail(`answer clock ran out after ${waited}s`);
  if (!song().guesses.some(g => g.id === raviId && g.timeout)) fail("timeout was not recorded");
  await answer(meena, displayTitle(await currentTitle()));
  await revealed(3);

  // Song 4: everyone answers wrong, which reveals with nobody scoring.
  await nextSong(4);
  await live(4, 0);
  const before4 = hostState().players.map(p => p.score).join();
  for (const p of [asha, ravi, meena]){
    await buzz(p);
    await until(`${p.label} answering`, () => song().answering === idOf(p.label));
    await answer(p, await wrongTitle());
  }
  await revealed(4);
  if (song().winner !== null || hostState().players.map(p => p.score).join() !== before4) fail("everyone wrong still scored");
  await host.page.getByText("Nothing for anyone").waitFor();
  await host.page.getByRole("button", { name: "To the box office" }).click();
  await host.page.getByText("After round 1").waitFor();
  await shot(host, "host-09-board");

  // Song 5: "Heard it too much". One vote of three is not enough, two are;
  // then the host skips on its own until the room's cap is used up.
  await nextSong(5);
  await live(5, 0);
  const voteBtn = p => p.page.getByRole("button", { name: /^Heard it too much|^Voted to skip/ });
  const hostSkip = host.page.getByRole("button", { name: /^Heard it too much/ });
  const skipTo = async (used, before) => {
    await until(`skip ${used}`, () => hostState().skips.used === used);
    await host.page.getByText("Skipped", { exact: true }).waitFor({ timeout: 10000 });
    if ((await host.page.getByText(before.title, { exact: true }).count()) !== 1) fail("skipped title not on the host screen");
    const after = await hostShow();
    if (after.idx !== before.idx + 1 || after.skipsSeen !== used) fail(`skip ${used} moved the host from ${before.idx} to ${after.idx}`);
    if ((after.queue[after.idx].tier ?? null) !== before.tier) fail(`skip ${used}: replacement tier ${after.queue[after.idx].tier} != ${before.tier}`);
    const tired = await host.page.evaluate(() => JSON.parse(localStorage.getItem("tt_tired") || "{}"));
    if (!(Date.now() - tired[songKey(before.title)] < 60e3)) fail(`skip ${used}: song not on the tired cooldown`);
    if (song().n !== 5 || hostState().results.length !== 4) fail("a skip changed the song number or the results");
    await live(5, 0);
  };
  // A second host socket, as a script would send what the app never does.
  const rawHost = async () => {
    const ws = new WebSocket(worker.origin.replace(/^http/, "ws") + "/parties/room/" + code, { headers: { origin } });
    const got = [];
    ws.onmessage = e => got.push(JSON.parse(String(e.data)));
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ t: "host", token: (await hostShow()).host }));
    await sleep(300);
    return { got, send: async m => { got.length = 0; ws.send(JSON.stringify(m)); await sleep(300); return got.find(x => x.t === "error")?.code; }, close: () => ws.close() };
  };
  const cued = async () => { const s = await hostShow(); const t = s.queue[s.idx]; return { idx: s.idx, title: displayTitle(t.title), tier: t.tier ?? null }; };
  if (hostState().skips.used !== 0 || hostState().skips.max < 2) fail(`unexpected skip budget ${JSON.stringify(hostState().skips)}`);
  let before = await cued();
  const firstCue = song().cue;
  await voteBtn(asha).click();
  await until("Asha's vote", () => song().votes.length === 1);
  await sleep(600);
  if (song().state !== "live" || hostState().skips.used !== 0) fail("one vote of three skipped the song");
  await host.page.getByText(/^Skip votes 1 of 2/).waitFor();
  await asha.page.getByRole("button", { name: "Voted to skip · 1 of 2" }).waitFor();
  await ravi.page.getByRole("button", { name: "Heard it too much · 1 of 2" }).waitFor();
  await shot(host, "host-12-skip-vote");
  await shot(asha, "phone-12-voted");
  await voteBtn(ravi).click();
  await skipTo(1, before);
  if (song().votes.length) fail("votes carried over to the new song");
  if (song().cue === firstCue) fail("the replacement kept the skipped song's cue");
  // A skip meant for the skipped song, arriving late, can't skip its replacement.
  {
    const h = await rawHost();
    const code1 = await h.send({ t: "skip", cue: firstCue });
    h.close();
    if (code1 !== "stale") fail(`a late skip for the old cue answered ${code1}`);
    if (hostState().skips.used !== 1 || song().state !== "live") fail("a late skip hit the replacement");
  }
  for (let used = 2; used <= hostState().skips.max; used++){
    before = await cued();
    await hostSkip.click();
    await skipTo(used, before);
  }
  await hostSkip.waitFor();
  if (!(await hostSkip.isDisabled())) fail("host can skip past the cap");
  if (await voteBtn(meena).count()) fail("phones can vote past the cap");
  await shot(host, "host-13-skips-used");
  // The room itself holds the cap, whatever a client sends.
  {
    const h = await rawHost();
    const capped = await h.send({ t: "skip", cue: song().cue });
    h.close();
    if (capped !== "no-skips") fail(`a skip past the cap answered ${capped}`);
    if (hostState().skips.used !== hostState().skips.max) fail("a refused skip changed the count");
  }

  // The rest of the show: one quick right answer per song, alternating.
  const reloadHost = async () => {
    await host.page.reload();
    await host.page.getByText("Buzz-in show in progress").waitFor();
  };
  for (let n = 5; n <= show.total; n++){
    await nextSong(n);
    await live(n, 0);
    const p = phones[n % 3];
    await buzz(p);
    if (n === 7){
      // The host screen reloads while a phone is answering, and the phone gets
      // it right while the host is away. Resume must pick up the room's
      // result (the reveal), not replay the song and score it twice.
      await until(`${p.label} answering`, () => song().answering === idOf(p.label));
      const title = displayTitle(await currentTitle());
      const before = scoreOf(p.label);
      await reloadHost();
      await answer(p, title);
      // The host's socket is gone, so this reads what the phone was told.
      await until("song 7 scored while the host was away", () => latest[p.label]?.song?.n === 7 && latest[p.label].song.state === "revealed");
      await shot(host, "host-11-resume-setup");
      await host.page.getByRole("button", { name: "Resume" }).click();
      await host.page.getByRole("button", { name: "Next song" }).waitFor({ timeout: 20000 });
      await host.page.getByText(new RegExp(`^\\+${CLIP_POINTS[0]} for ${p.label}`, "i")).waitFor();
      if (scoreOf(p.label) !== before + CLIP_POINTS[0]) fail(`song 7 scored ${scoreOf(p.label) - before}, not ${CLIP_POINTS[0]} once`);
      if (hostState().results.filter(r => r.n === 7).length !== 1) fail("song 7 has more than one result");
      continue;
    }
    await answer(p, displayTitle(await currentTitle()));
    await revealed(n);
  }
  // The host reloads on the final reveal: it comes back to that reveal and the
  // end of the show, not a 13th song.
  const finalScores = hostState().players.map(pl => pl.score).join();
  await reloadHost();
  await host.page.getByRole("button", { name: "Resume" }).click();
  await host.page.getByRole("button", { name: "Final box office" }).waitFor({ timeout: 20000 });
  if (song().n !== show.total || hostState().results.length !== show.total) fail("resume on the final reveal moved the room on");
  if (hostState().players.map(pl => pl.score).join() !== finalScores) fail("scores changed across a host reload");
  await host.page.getByRole("button", { name: "Final box office" }).click();
  await host.page.getByText("Final count").waitFor();
  await host.page.getByRole("button", { name: "Roll the credits" }).click();
  await host.page.getByRole("button", { name: "Same crowd again" }).waitFor();
  await until("room over", () => hostState().phase === "over");
  await shot(host, "host-10-podium");

  // Podium, room and phones agree.
  const ranked = [...hostState().players].sort((a, b) => b.score - a.score);
  const text = await host.page.locator("main").innerText();
  for (const pl of ranked) if (!text.includes(pl.name.toUpperCase()) && !text.includes(pl.name)) fail(`${pl.name} missing from the podium`);
  for (const pl of ranked.slice(0, 3)) if (!text.includes(String(pl.score))) fail(`${pl.name}'s ${pl.score} missing from the podium`);
  const expected = { Asha: 0, Ravi: 0, Meena: 0 };
  for (const r of hostState().results) if (r.winner) expected[nameOf(r.winner)] += r.points;
  for (const pl of ranked) if (pl.score !== expected[pl.name]) fail(`${pl.name} has ${pl.score}, results add up to ${expected[pl.name]}`);
  for (const p of phones){
    const mine = ranked.find(r => r.name === p.label);
    const place = ranked.findIndex(r => r.score === mine.score) + 1;
    await p.page.getByText(`${mine.score} points`).waitFor({ timeout: 10000 });
    await p.page.getByText(place === 1 ? "You take it" : new RegExp(`^${place}(st|nd|rd|th) place$`)).waitFor();
  }
  await shot(asha, "phone-11-final");

  // No phone received any title of this show before that song's reveal, in
  // any kind of frame (welcome, state, error, reconnect snapshots), a title
  // list of any kind, or anything that looks like a stream.
  const quoted = t => [JSON.stringify(t), JSON.stringify(displayTitle(t))];
  let frames = 0;
  for (const p of phones){
    const shown = new Set();
    for (const f of traffic[p.label] || []){
      if (f.dir !== "in") continue;
      frames++;
      if (/saavncdn|https?:|\.mp4|\.m4a|stream/i.test(f.data)) fail(`${p.label} received a URL or stream: ${f.data.slice(0, 160)}`);
      const m = JSON.parse(f.data);
      if (m.t === "titles" || Array.isArray(m.titles)) fail(`${p.label} received a title list`);
      if (m.t === "state"){
        for (const r of m.results || []) shown.add(songKey(r.title));
        if (m.song?.answer){
          if (m.song.state !== "revealed") fail(`${p.label} got the answer to song ${m.song.n} before the reveal`);
          shown.add(songKey(m.song.answer.title));
        }
      }
      for (const t of show.queue){
        if (shown.has(songKey(t.title))) continue;
        if (quoted(t.title).some(q => f.data.includes(q))) fail(`${p.label} saw "${t.title}" before its reveal: ${f.data.slice(0, 160)}`);
      }
    }
  }
  if (!frames) fail("recorded no phone traffic");

  // Same crowd again restarts the room with scores at zero.
  await host.page.getByRole("button", { name: "Same crowd again" }).click();
  await until("second show live", () => hostState().phase === "show" && song()?.n === 1 && song().state === "live", 60000);
  if (hostState().players.some(p => p.score !== 0)) fail("scores not reset for the next show");
  await asha.page.locator('button[aria-label="Buzz"]').waitFor({ timeout: 15000 });
  // A new show has its skips back; votes close for everyone once someone buzzes.
  if (hostState().skips.used !== 0) fail("skips not reset for the next show");
  await voteBtn(asha).waitFor({ timeout: 10000 });
  await buzz(meena);
  await voteBtn(asha).waitFor({ state: "detached", timeout: 5000 });
  await until("buzz answered", async () => { await host.page.waitForTimeout(0); return song().answering === idOf("Meena"); });

  if (overflow.length) fail("screens scroll at this size: " + overflow.join(", "));
  await guards(code, (await hostShow()).host, show.total);
  const errors = all.flatMap(d => d.errors);
  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  console.log(`room: PASS (room ${code}, ${show.total} songs, ${frames} phone frames checked, deadStreams=${deadStreams})`);
} catch (e){
  console.error("room: FAIL", e.message);
  console.error("host view:", JSON.stringify({ ...latest.host, results: undefined }).slice(0, 600));
  for (const d of all) console.error(`--- ${d.label} page rx`, JSON.stringify(await d.page.evaluate(() => window.__rx).catch(() => null)), "proxy in:", (traffic[d.label] || []).filter(f => f.dir === "in").length);
  for (const [label, log] of Object.entries(traffic)) console.error(`--- ${label} last frames\n` + log.slice(-6).map(f => `${f.dir} ${new Date(f.at).toISOString().slice(17, 23)} ${f.data.slice(0, 140)}`).join("\n"));
  for (const d of all) console.error(`--- ${d.label} app log\n` + d.logs.slice(-15).join("\n"));
  if (shotsDir) for (const d of all) await d.page.screenshot({ path: path.join(shotsDir, `fail-${d.label}.png`) }).catch(() => {});
  exit = 1;
} finally {
  for (const d of all) await d.browser.close().catch(() => {});
  server.close();
  worker.stop();
}
process.exit(exit);
