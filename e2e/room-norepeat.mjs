/* No repeats in a buzz-in room, with nothing to set up. Desktop Chromium
   hosts, WebKit iPhones buzz, against a local `wrangler dev` (or --worker).
   Each phone's history is seeded the way playing leaves it (tt_played,
   tt_tired), then:
   - every phone brings the songs it is still sitting out to its seat, and
     the room hands the host only the merged list (seats per song);
   - the room enforces the payload caps (frame size, song count, key length,
     hours) and a seat that leaves the lobby takes its songs with it;
   - the host's crate holds none of the seated phones' songs;
   - a revealed song lands in every phone's played history, a vote-skipped
     one in the voters' tired history and the others' played history;
   - a phone that reloads, or drops offline, keeps its songs in the room;
   - a phone that sits down mid-show gets its next song swapped out;
   - a second room with the same phones leaves out what the first one played;
   - no phone receives another phone's history, the merged list, a URL, or
     any title of the show before its reveal (a skipped one only as its key,
     after the skip).
   node e2e/room-norepeat.mjs [--worker=https://...] */
import fs from "node:fs";
import { chromium, webkit, devices } from "playwright";
import { serve, args, localWorker, silence, skipLanding, moreSettings, wireWorker, MUTE_ARGS } from "./harness.mjs";
import { displayTitle, songKey, shuffle } from "../src/lib/utils.js";
import { ROOM_HEARD } from "../src/lib/constants.js";

const A = args({});
const worker = A.worker ? { origin: A.worker.replace(/\/$/, ""), stop(){} } : await localWorker();
const server = await serve();
const url = server.url;
const origin = new URL(url).origin;
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOUR = 3600e3, DAY = 24 * HOUR;

const traffic = {}; // label -> frames through the proxy
const latest = {};  // label -> last room state
const heard = {};   // label -> last merged history the room sent (host only)

async function device(kind, label){
  const desk = kind === "host";
  const browser = desk ? await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] }) : await webkit.launch();
  const context = await browser.newContext(desk ? { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } : { ...devices["iPhone 13"], reducedMotion: "reduce" });
  await wireWorker(context, worker.origin, origin, traffic[label] ||= [], {
    onIn: m => { if (m.t === "state") latest[label] = m; else if (m.t === "heard") heard[label] = m.songs; },
  });
  await context.addInitScript(silence);
  await context.addInitScript(skipLanding);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`${label}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  return { label, browser, context, page, errors };
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

// Easy-tier corpus songs in both languages: what an Easy room's crate draws from.
const corpus = JSON.parse(fs.readFileSync(new URL("../dist/corpus.json", import.meta.url), "utf8"));
const col = n => corpus.cols.indexOf(n);
const easy = shuffle([...new Set(corpus.songs.filter(r => r[col("tier")] === "easy").map(r => songKey(r[col("title")])))]);
const publicTitles = corpus.songs.map(r => displayTitle(r[col("title")]));
const now = Date.now();
const seeds = {
  asha: easy.slice(0, 150),           // played an hour ago: out for about 7 days
  ravi: easy.slice(150, 210),         // skipped as tired 20 days ago: out for about 10 more
  raviOld: easy.slice(210, 250),      // played 8 days ago: back in
  meena: Array.from({ length: 400 }, (_, i) => `zz meena ${String(i).padStart(3, "0")}`),
};
const histories = {
  Asha: { tt_played: Object.fromEntries(seeds.asha.map(k => [k, now - HOUR])) },
  Ravi: { tt_tired: Object.fromEntries(seeds.ravi.map(k => [k, now - 20 * DAY])), tt_played: Object.fromEntries(seeds.raviOld.map(k => [k, now - 8 * DAY])) },
  Meena: { tt_played: Object.fromEntries(seeds.meena.map((k, i) => [k, now - (i + 1) * 60e3])) },
};

const readHistory = p => p.page.evaluate(() => ({
  played: JSON.parse(localStorage.getItem("tt_played") || "{}"),
  tired: JSON.parse(localStorage.getItem("tt_tired") || "{}"),
}));
const recent = at => Date.now() - at < 5 * 60e3;
const hostShow = h => h.page.evaluate(() => JSON.parse(localStorage.getItem("tt_room_host") || "null"));

async function openRoom(h){
  await h.page.goto(url + "seed.html");
  await h.page.evaluate(() => localStorage.clear());
  await h.page.goto(url);
  await h.page.getByRole("radio", { name: "Buzz in" }).click();
  await moreSettings(h.page);
  await h.page.getByRole("radio", { name: "Easy", exact: true }).click();
  await h.page.getByRole("radio", { name: "3", exact: true }).click();
  await h.page.getByRole("button", { name: "Open a room" }).click();
  await h.page.getByText("Doors open").waitFor({ timeout: 20000 });
  return (await hostShow(h)).code;
}
async function join(p, code){
  // A hash change alone does not reload the app, and a real phone opens the link fresh.
  await p.page.goto(url + "seed.html");
  await p.page.goto(url + "#room=" + code);
  await p.page.getByLabel("Your name").fill(p.label);
  await p.page.getByRole("button", { name: "Join the show" }).click();
  await until(`${p.label} seated in ${code}`, () => latest[p.label]?.code === code && latest[p.label].me, 15000);
}
async function start(h, n){
  await until(`${n} players in ${h.label}'s lobby`, () => latest[h.label]?.players.length === n && latest[h.label].players.every(p => p.online));
  await h.page.getByRole("button", { name: "Start the show" }).click();
  return until("host queue", async () => { const s = await hostShow(h); return s?.started && s.queue.length ? s : null; }, 60000);
}

// A raw socket straight to the room, speaking the protocol as a script would.
async function raw(code){
  const ws = new WebSocket(worker.origin.replace(/^http/, "ws") + "/parties/room/" + code, { headers: { origin } });
  const got = [], frames = [];
  const conn = { ws, got, frames, code: 0 };
  ws.onmessage = e => { frames.push(String(e.data)); got.push(JSON.parse(String(e.data))); };
  conn.closed = new Promise(r => { ws.addEventListener("close", e => { conn.code = e.code; r(e.code); }); });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  conn.send = async m => { ws.send(typeof m === "string" ? m : JSON.stringify(m)); await sleep(400); };
  return conn;
}
const closedWith = (c, ms = 3000) => Promise.race([c.closed, sleep(ms).then(() => 0)]);

const host = await device("host", "host");
const [asha, ravi, meena] = await Promise.all(["Asha", "Ravi", "Meena"].map(n => device("phone", n)));
const phones = [asha, ravi, meena];
let dev = null, host2 = null;
const all = () => [host, ...phones, dev, host2].filter(Boolean);
let exit = 0;
try {
  for (const p of phones){
    await p.page.goto(url + "seed.html");
    await p.page.evaluate(h => { localStorage.clear(); for (const [k, v] of Object.entries(h)) localStorage.setItem(k, JSON.stringify(v)); }, histories[p.label]);
  }

  // Room 1.
  const code = await openRoom(host);
  for (const p of phones) await join(p, code);
  const H = () => heard.host || {};
  await until("every phone's songs at the host", () => seeds.asha.every(k => H()[k]) && seeds.ravi.every(k => H()[k]) && H()["zz meena 000"]);

  // What each phone sent: its songs still sitting out, as hours, capped.
  const joinOf = label => JSON.parse(traffic[label].filter(f => f.dir === "out" && f.data.startsWith('{"t":"join"')).at(-1).data);
  const sent = Object.fromEntries(phones.map(p => [p.label, joinOf(p.label).heard]));
  if (Object.keys(sent.Meena).length !== ROOM_HEARD.songs) fail(`Meena sent ${Object.keys(sent.Meena).length} songs, not the cap of ${ROOM_HEARD.songs}`);
  if (!sent.Meena["zz meena 000"] || sent.Meena["zz meena 399"]) fail("Meena's phone did not keep its most recent songs under the cap");
  if (seeds.raviOld.some(k => sent.Ravi[k] || H()[k])) fail("songs back from their cooldown were sent to the room");
  for (const k of seeds.asha) if (!(H()[k][0] >= 7 * 24 - 2 && H()[k][0] <= 7 * 24)) fail(`Asha's "${k}" comes back in ${H()[k][0]}h`);
  for (const k of seeds.ravi) if (!(H()[k][0] >= 10 * 24 - 2 && H()[k][0] <= 10 * 24)) fail(`Ravi's tired "${k}" comes back in ${H()[k][0]}h`);
  if (Object.keys(H()).filter(k => k.startsWith("zz meena")).length !== ROOM_HEARD.songs) fail("the host did not get Meena's capped songs");

  // The room holds the caps itself, whatever a client sends.
  const big = await raw(code);
  await big.send({ t: "join", key: "b".repeat(24), name: "Big", heard: Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`zz big ${i} ${"x".repeat(30)}`, 5])) });
  if ((await closedWith(big)) !== 1009) fail(`an oversized join was not refused (${big.code})`);
  const bad = {
    ["x".repeat(ROOM_HEARD.key + 1)]: 5, "zz bad zero": 0, "zz bad float": 1.5, "zz bad neg": -3, "zz bad str": "5",
    "zz bad far": ROOM_HEARD.hours + 1, "zz bad \u0001ctl": 5, "": 5,
  };
  const many = Object.fromEntries(Array.from({ length: ROOM_HEARD.songs + 100 }, (_, i) => [`zz raw ${String(i).padStart(3, "0")}`, 10]));
  const probe = await raw(code);
  await probe.send({ t: "join", key: "p".repeat(24), name: "Probe", heard: { ...bad, ...many } });
  const odd = await raw(code);
  await odd.send({ t: "join", key: "o".repeat(24), name: "Odd", heard: ["not", "a", "map"] });
  if (!probe.got.some(m => m.t === "welcome") || !odd.got.some(m => m.t === "welcome")) fail("a join with a history was refused a seat");
  await until("the probe's songs at the host", () => H()["zz raw 000"]);
  const rawKeys = Object.keys(H()).filter(k => k.startsWith("zz raw"));
  if (rawKeys.length !== ROOM_HEARD.songs) fail(`the room kept ${rawKeys.length} of a seat's songs, cap ${ROOM_HEARD.songs}`);
  if (Object.keys(bad).some(k => k in H())) fail(`the room kept a malformed entry: ${Object.keys(bad).filter(k => k in H())}`);
  if (H()["zz raw 000"][1] !== 1 || seeds.asha.some(k => H()[k][1] !== 1)) fail("seat counts are off");
  // Neither probe, a phone as far as the room knows, heard anyone's history.
  for (const c of [probe, odd]) for (const f of c.frames){
    if (f.includes('"t":"heard"') || f.includes("zz meena") || seeds.asha.some(k => f.includes(JSON.stringify(k)))) fail(`a phone socket received another phone's history: ${f.slice(0, 120)}`);
  }
  // Seats that leave the lobby take their songs with them.
  await probe.send({ t: "leave" });
  const hostSock = await raw(code);
  await hostSock.send({ t: "host", token: (await hostShow(host)).host });
  await hostSock.send({ t: "kick", id: odd.got.find(m => m.t === "welcome").seat });
  await until("the probe's songs gone", () => !H()["zz raw 000"] && latest.host.players.length === 3);
  if (!seeds.asha.every(k => H()[k])) fail("a leaving seat took other seats' songs with it");
  hostSock.ws.close();

  // The crate holds none of the seated phones' songs.
  const show = await start(host, 3);
  const inQueue = new Set(show.queue.map(t => songKey(t.title)));
  const repeats = [...seeds.asha, ...seeds.ravi].filter(k => inQueue.has(k));
  if (repeats.length) fail(`room 1's crate repeats ${repeats.length} songs the phones heard: ${repeats.slice(0, 5)}`);
  console.log(`room 1 ${code}: crate of ${show.queue.length}, none of the ${seeds.asha.length + seeds.ravi.length} songs the phones are sitting out`);

  const song = () => latest.host?.song;
  const idOf = name => latest.host.players.find(p => p.name === name)?.id;
  const live = n => until(`song ${n} live`, async () => {
    if (song()?.n === n && song().state === "live") return true;
    const skip = host.page.getByRole("button", { name: "Skip this song" });
    if (await skip.isVisible().catch(() => false)) await skip.click({ timeout: 1500 }).catch(() => {});
    return false;
  }, 45000);
  const current = async () => (await hostShow(host)).queue[(await hostShow(host)).idx];
  const nextSong = async n => {
    const next = host.page.getByRole("button", { name: /Next song|box office|On to round/ });
    await until(`song ${n} cued`, async () => {
      if (song()?.n === n) return true;
      if (await next.count() && await next.first().isEnabled({ timeout: 500 }).catch(() => false)) await next.first().click({ timeout: 1500 }).catch(() => {});
      return false;
    });
  };

  // Song 1: Asha names it. Every phone keeps it as played.
  await live(1);
  const key1 = songKey((await current()).title);
  await until("Asha's buzz", async () => {
    if (song().answering === idOf("Asha")) return true;
    await asha.page.locator('button[aria-label="Buzz"]').click({ timeout: 1500 }).catch(() => {});
    return false;
  });
  await asha.page.getByLabel("Your answer").fill(displayTitle((await current()).title));
  await asha.page.getByRole("button", { name: "Lock it in" }).click();
  await until("song 1 revealed", () => song().n === 1 && song().state === "revealed");
  for (const p of phones) await until(`song 1 in ${p.label}'s history`, async () => recent((await readHistory(p)).played[key1] || 0), 10000);

  // Song 2: Asha and Ravi vote it out. They keep it as tired, Meena as played.
  await nextSong(2);
  await live(2);
  const key2 = songKey((await current()).title);
  const vote = p => p.page.getByRole("button", { name: /^Heard it too much/ }).click();
  await vote(asha);
  await until("Asha's vote", () => song().votes.length === 1);
  await vote(ravi);
  await until("song 2 skipped", () => latest.host.skips.used === 1);
  for (const p of [asha, ravi]) await until(`song 2 tired on ${p.label}`, async () => recent((await readHistory(p)).tired[key2] || 0), 10000);
  await until("song 2 played on Meena", async () => recent((await readHistory(meena)).played[key2] || 0), 10000);
  if ((await readHistory(meena)).tired[key2]) fail("a phone that did not vote keeps the skipped song as tired");
  await live(2);

  // Meena reloads: her seat comes back with her history as it is now.
  const meenaId = idOf("Meena");
  heard.host = null;
  await meena.page.reload();
  await until("Meena back with her songs", () => latest.host.players.find(p => p.id === meenaId)?.online && H()[key1] && H()[key2] && H()["zz meena 000"]);
  if (latest.host.players.length !== 3 || idOf("Meena") !== meenaId) fail("Meena's reload took a new seat");
  // Offline, her seat still counts: a fresh host socket gets her songs.
  await meena.page.goto(url + "seed.html");
  await until("Meena offline", () => !latest.host.players.find(p => p.id === meenaId)?.online);
  const check = await raw(code);
  await check.send({ t: "host", token: (await hostShow(host)).host });
  const offline = check.got.find(m => m.t === "heard")?.songs || {};
  check.ws.close();
  if (!offline["zz meena 000"] || !offline[key2]) fail("an offline seat's songs left the room");
  await meena.page.goto(url + "#room=" + code);
  await until("Meena online", () => latest.host.players.find(p => p.id === meenaId)?.online);

  // Dev sits down mid-show having just heard the song that is up next.
  const s2 = await hostShow(host);
  const upNext = s2.queue[s2.idx + 1];
  dev = await device("phone", "Dev");
  await dev.page.goto(url + "seed.html");
  await dev.page.evaluate(k => { localStorage.clear(); localStorage.setItem("tt_played", JSON.stringify({ [k]: Date.now() - 3600e3 })); }, songKey(upNext.title));
  await join(dev, code);
  await until("Dev's song at the host", () => H()[songKey(upNext.title)]);
  await host.page.getByRole("button", { name: "Reveal it" }).click();
  await until("song 2 revealed", () => song().n === 2 && song().state === "revealed");
  await nextSong(3);
  const third = await current();
  if (songKey(third.title) === songKey(upNext.title)) fail("the song a late phone just heard came up next anyway");
  if ((third.tier ?? null) !== (upNext.tier ?? null)) fail(`the swapped-in song is ${third.tier}, not ${upNext.tier}`);
  const results1 = latest.host.results.map(r => songKey(r.title));
  for (const p of phones){
    const h = await readHistory(p);
    const missing = results1.filter(k => !recent(h.played[k] || 0));
    if (missing.length) fail(`${p.label} did not keep revealed songs: ${missing}`);
  }
  const queue1 = show.queue;
  await host.browser.close();

  // Room 2, a new host screen with no history of its own: the phones' histories
  // alone keep room 1's songs and the seeds out.
  host2 = await device("host", "host2");
  const code2 = await openRoom(host2);
  for (const p of phones) await join(p, code2);
  await until("room 2 has the phones' songs", () => heard.host2?.[key1] && heard.host2[key2] && seeds.asha.every(k => heard.host2[k]));
  await until("song 1 heard by all three seats", () => heard.host2[key1][1] === 3 && heard.host2[key2][1] === 3, 5000);
  const show2 = await start(host2, 3);
  const q2 = new Set(show2.queue.map(t => songKey(t.title)));
  const back = [...results1, key2, ...seeds.asha, ...seeds.ravi].filter(k => q2.has(k));
  if (back.length) fail(`room 2 repeats ${back.length} songs: ${back.slice(0, 5)}`);
  console.log(`room 2 ${code2}: crate of ${show2.queue.length}, none of room 1's ${results1.length + 1} songs or the seeds`);

  // Secrecy, over every frame each phone received in both rooms.
  const queue = [...queue1, ...show2.queue];
  const others = label => [
    ...(label !== "Asha" ? seeds.asha : []), ...(label !== "Ravi" ? seeds.ravi : []), ...(label !== "Meena" ? ["zz meena 000", "zz meena 150"] : []),
    ...(label !== "Dev" ? [songKey(upNext.title)] : []), "zz raw 000",
  ];
  let frames = 0;
  for (const p of [...phones, dev]){
    const shown = new Set();
    for (const f of traffic[p.label] || []){
      if (f.dir !== "in") continue;
      frames++;
      if (/saavncdn|https?:|\.mp4|\.m4a|stream/i.test(f.data)) fail(`${p.label} received a URL: ${f.data.slice(0, 160)}`);
      const m = JSON.parse(f.data);
      if (m.t === "heard") fail(`${p.label} received the room's merged history`);
      if (m.t === "state"){
        for (const r of m.results || []) shown.add(songKey(r.title));
        for (const x of m.skipped || []) shown.add(x.key);
        if (m.song?.answer && m.song.state !== "revealed") fail(`${p.label} got song ${m.song.n}'s answer early`);
        if (m.song?.answer) shown.add(songKey(m.song.answer.title));
      }
      for (const k of others(p.label)) if (!shown.has(k) && f.data.includes(JSON.stringify(k))) fail(`${p.label} received another phone's song "${k}"`);
      for (const t of queue){
        const k = songKey(t.title);
        if (shown.has(k)) continue;
        if ([JSON.stringify(t.title), JSON.stringify(displayTitle(t.title)), JSON.stringify(k)].some(q => f.data.includes(q))) fail(`${p.label} saw "${t.title}" before its reveal`);
      }
    }
  }
  if (!frames) fail("recorded no phone traffic");
  if (!publicTitles.length) fail("no public titles");

  const errors = all().flatMap(d => d.errors);
  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  console.log(`room-norepeat: PASS (rooms ${code} and ${code2}, ${frames} phone frames checked)`);
} catch (e){
  console.error("room-norepeat: FAIL", e.message);
  for (const [label, log] of Object.entries(traffic)) console.error(`--- ${label} last frames\n` + log.slice(-5).map(f => `${f.dir} ${f.data.slice(0, 140)}`).join("\n"));
  exit = 1;
} finally {
  for (const d of all()) await d.browser.close().catch(() => {});
  server.close();
  worker.stop();
}
process.exit(exit);
