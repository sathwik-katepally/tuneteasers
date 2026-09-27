/* A buzz-in room the way a party plays it: desktop Chromium is the host
   screen and three WebKit iPhones (separate contexts) are the buzzers.
   The deployed Worker host is rerouted to a local `wrangler dev` (started
   here) or to --worker=<origin>; room WebSockets go through a proxy in this
   script, which also records every frame each phone receives. Checks:
   - joining by code (typed) and by the #room link,
   - a buzz race is answered in the order buzzes reached the room,
   - a wrong answer passes to the next buzzer, a right one scores the rung,
   - nobody knowing carries the clip ladder on (manual and automatic),
   - the answer timer runs out, and everyone locked out reveals the song,
   - a phone that reloads mid-show keeps its seat and score,
   - the podium matches the room, and every phone's final place does too,
   - no phone ever receives the title before its reveal, or any stream URL.
   node e2e/room.mjs [--host=phone] [--worker=https://...] [--shots=dir] */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { serve, args, localWorker } from "./harness.mjs";
import { displayTitle } from "../src/lib/utils.js";
import { CLIP_POINTS, ROOM_ANSWER_SECS } from "../src/lib/config.ts";

const A = args({});
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
    ? await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
    : await webkit.launch();
  const context = await browser.newContext(desk
    ? { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }
    : { ...devices["iPhone 13"], reducedMotion: "reduce" });
  await wire(context, label);
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
async function wrongTitle(){
  const right = displayTitle(await currentTitle());
  const s = await hostShow();
  return displayTitle(s.queue.find((t, i) => i !== s.idx && displayTitle(t.title) !== right).title);
}

const buzzBtn = p => p.page.locator('button[aria-label="Buzz"]');
// A tap that lands just as buzzing closes (the song was revealed) is rightly
// ignored, so a buzz counts once the room has the phone in its queue.
async function buzz(p){
  const inRoom = () => { const s = song(), id = idOf(p.label); return s && (s.answering === id || s.queue.includes(id)); };
  const t0 = Date.now();
  for (;;){
    await buzzBtn(p).waitFor({ timeout: 20000 });
    await buzzBtn(p).click();
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
const live = (n, rung) => until(`song ${n} live at rung ${rung}`, () => song()?.n === n && song().state === "live" && song().rung === rung);

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
   a phone playing host, oversized frames, frames before a hello, and floods. */
async function guards(code){
  const wsBase = worker.origin.replace(/^http/, "ws") + "/parties/room/";
  const connect = (c, o = origin) => new Promise(res => {
    const ws = new WebSocket(wsBase + c, { headers: { origin: o } });
    const got = [];
    ws.onmessage = e => got.push(JSON.parse(String(e.data)));
    ws.onopen = () => res({ ws, got, open: true });
    ws.onerror = () => res({ ws, got, open: false });
    ws.closed = new Promise(r => { ws.onclose = e => r(e.code); });
  });
  const bad = await connect(code, "https://evil.example");
  if (bad.open) fail("a foreign origin opened a room socket");
  const post = await fetch(worker.origin + "/api/rooms", { method: "POST", headers: { origin: "https://evil.example" } });
  if (post.status !== 403) fail(`a foreign origin made a room (${post.status})`);
  const none = await connect(code === "BBBB" ? "CCCC" : "BBBB");
  none.ws.send(JSON.stringify({ t: "join", key: "n".repeat(24), name: "Nobody" }));
  if ((await Promise.race([none.ws.closed, sleep(3000).then(() => 0)])) !== 4404) fail("an unknown room code was not closed with 4404");
  const fake = await connect(code);
  fake.ws.send(JSON.stringify({ t: "host", token: "A".repeat(22) }));
  if ((await Promise.race([fake.ws.closed, sleep(3000).then(() => 0)])) !== 4403) fail("a wrong host token was not refused");
  const early = await connect(code);
  early.ws.send(JSON.stringify({ t: "buzz" }));
  await sleep(300);
  if (!early.got.some(m => m.code === "hello-first")) fail("a buzz before hello was not refused");
  early.ws.send(JSON.stringify({ t: "join", key: "g".repeat(24), name: "Guard" }));
  await sleep(300);
  early.ws.send(JSON.stringify({ t: "answer", text: "x".repeat(2000) }));
  early.ws.send(JSON.stringify({ t: "end" }));
  await sleep(300);
  if (!early.got.some(m => m.code === "too-big")) fail("an oversized frame was not refused");
  if (!early.got.some(m => m.code === "unknown")) fail("a phone could send a host command");
  if (hostState().phase === "over") fail("a phone ended the show");
  let refused = 0;
  const before = early.got.length;
  for (let i = 0; i < 60; i++) early.ws.send(JSON.stringify({ t: "answer", text: "flood" }));
  await sleep(500);
  refused = 60 - early.got.slice(before).filter(m => m.code === "not-your-turn").length;
  if (refused < 30) fail(`a flood of 60 frames was mostly handled (${60 - refused} answered)`);
  for (const c of [bad, none, fake, early]) try { c.ws.close(); } catch {}
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
  await host.page.getByRole("radio", { name: "Easy", exact: true }).click();
  await host.page.getByRole("radio", { name: "3", exact: true }).click();
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
  const titles = await until("titles on the phones", () => traffic.Asha.find(f => f.data.includes('"t":"titles"')));
  const titleList = JSON.parse(titles.data).titles;
  const show = await until("host queue", async () => { const s = await hostShow(); return s?.started && s.queue.length ? s : null; });
  if (!show.queue.slice(0, show.total).every(t => titleList.includes(displayTitle(t.title)))) fail("a show title is missing from the autocomplete list");
  if (titleList.length < show.total * 2) fail(`autocomplete list has no decoys (${titleList.length} titles for ${show.total} songs)`);

  // Song 1: a buzz race. Ravi, then Asha, then Meena; Ravi answers wrong,
  // Asha right at the rung she buzzed on.
  await live(1, 0);
  await shot(host, "host-04-playing");
  await shot(asha, "phone-04-buzzer-live");
  buzzLog = [];
  await Promise.all([buzz(ravi), sleep(70).then(() => buzz(asha)), sleep(140).then(() => buzz(meena))]);
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
  await answer(second, title1);
  await revealed(1);
  if (scoreOf(second.label) !== CLIP_POINTS[0]) fail(`right answer on rung 0 scored ${scoreOf(second.label)}, not ${CLIP_POINTS[0]}`);
  if (scoreOf(first.label) !== 0 || scoreOf(third.label) !== 0) fail("someone else scored on song 1");
  await second.page.getByText("You got it").waitFor();
  await shot(second, "phone-08-won");
  await shot(third, "phone-09-reveal-other");
  await shot(host, "host-07-reveal");

  // Song 2: nobody buzzes, the host asks for more; a wrong answer with nobody
  // queued behind it carries the ladder on by itself; then a right one.
  await nextSong(2);
  await live(2, 0);
  const more = host.page.getByRole("button", { name: /^Hear \d+s$/ });
  await until("first clip over", () => host.page.getByText(/^Anyone\?/).isVisible());
  await shot(host, "host-08-grace");
  await more.click();
  await live(2, 1);
  await buzz(meena);
  await until("meena answering", () => song().answering === idOf("Meena"));
  await answer(meena, await wrongTitle());
  await until("song 2 missed", () => song().state === "missed" || song().rung === 2);
  await live(2, 2);
  await shot(meena, "phone-10-out-next-rung");
  await buzz(asha);
  await answer(asha, (await currentTitle()).toLowerCase().replace(/aa/g, "a"), { pick: false });
  await revealed(2);
  const ashaAfter2 = (first.label === "Asha" ? 0 : second.label === "Asha" ? CLIP_POINTS[0] : 0) + CLIP_POINTS[2];
  if (scoreOf("Asha") !== ashaAfter2) fail(`Asha has ${scoreOf("Asha")}, expected ${ashaAfter2} (typed answer at rung 2)`);

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

  // The rest of the show: one quick right answer per song, alternating.
  for (let n = 5; n <= show.total; n++){
    await nextSong(n);
    await live(n, 0);
    const p = phones[n % 3];
    await buzz(p);
    await answer(p, displayTitle(await currentTitle()));
    await revealed(n);
  }
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

  // No phone saw a title before its reveal, or anything that looks like a stream.
  const answers = new Map(show.queue.map((t, i) => [i, displayTitle(t.title)]));
  const byN = new Map();
  for (const r of hostState().results) byN.set(r.n, displayTitle(r.title));
  let frames = 0;
  for (const p of phones) for (const f of traffic[p.label] || []){
    if (f.dir !== "in") continue;
    frames++;
    if (/saavncdn|https?:|\.mp4|\.m4a|stream/i.test(f.data)) fail(`${p.label} received a URL or stream: ${f.data.slice(0, 160)}`);
    const m = JSON.parse(f.data);
    if (m.t !== "state" || !m.song) continue;
    if (m.song.state !== "revealed"){
      if (m.song.answer) fail(`${p.label} got the answer to song ${m.song.n} before the reveal`);
      const t = byN.get(m.song.n);
      if (t && JSON.stringify({ ...m, results: [] }).includes(t)) fail(`${p.label} saw "${t}" during song ${m.song.n}`);
    }
  }
  if (!frames) fail("recorded no phone traffic");
  void answers;

  // Same crowd again restarts the room with scores at zero.
  await host.page.getByRole("button", { name: "Same crowd again" }).click();
  await until("second show live", () => hostState().phase === "show" && song()?.n === 1 && song().state === "live", 60000);
  if (hostState().players.some(p => p.score !== 0)) fail("scores not reset for the next show");
  await asha.page.locator('button[aria-label="Buzz"]').waitFor({ timeout: 15000 });

  if (overflow.length) fail("screens scroll at this size: " + overflow.join(", "));
  await guards(code);
  const errors = all.flatMap(d => d.errors);
  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  console.log(`room: PASS (room ${code}, ${show.total} songs, ${frames} phone frames checked)`);
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
