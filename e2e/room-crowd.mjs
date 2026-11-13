/* A buzz-in room with every seat taken. The big screen is desktop Chromium,
   one seat is a WebKit iPhone and the rest are raw sockets that only join,
   buzz and answer. Each seat count plays a 3-round show; every screen that
   lists players is shot on the big screen at 1920x1080 and at 390x844 (a phone
   as the host), and the phone's final screen at 390x844. A screen fails when
   the page scrolls or a player's name is not on screen; at 390px the lobby may
   scroll, as in e2e/room.mjs.
   node e2e/room-crowd.mjs [--seats=4,8,24] [--shots=dir] */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { serve, args, localWorker, silence, skipLanding, moreSettings, wireWorker, MUTE_ARGS } from "./harness.mjs";
import { displayTitle } from "../src/lib/utils.js";

const A = args({ seats: "4,8,24" });
const counts = A.seats.split(",").map(Number);
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;

// Some at the 24-character name limit, as a party types them.
const NAMES = ["Asha", "Ravi", "Meena", "Arjun", "Priya", "Karthik", "Lakshmi", "Venkatesh", "Divya", "Siddharth", "Ananya", "Rohit",
  "Sneha", "Vikram", "Pooja", "Harish", "Nandini", "Aditya", "Kavya", "Suresh Kumar", "Bhavana", "Rajeshwari Subramanian", "Mohan", "Chandrasekhar Venkataram"];
const BIG = { width: 1920, height: 1080 };
const SMALL = { width: 390, height: 844 };

const worker = await localWorker();
const server = await serve();
const url = server.url;
const origin = new URL(url).origin;
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, timeout = 30000){
  const t0 = Date.now();
  for (;;){
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/* A seat with no browser: it joins, then buzzes and answers when told. */
function rawSeat(code, name){
  const ws = new WebSocket(worker.origin.replace(/^http/, "ws") + "/parties/room/" + code, { headers: { origin } });
  const seat = { name, id: null, view: null, send: m => ws.send(JSON.stringify(m)), close: () => ws.close() };
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data));
    if (m.t === "welcome") seat.id = m.seat;
    if (m.t === "state") seat.view = m;
    if (m.t === "error") console.log(`${name}: room error ${m.code}`);
  };
  ws.onopen = () => seat.send({ t: "join", key: crypto.randomUUID().replace(/-/g, ""), name });
  return seat;
}

const problems = [];
/* Shoots the page as it is and records what does not fit: the page
   scrolling, anything in the stage past the right edge, and each of `names`
   that is not on screen (outside the viewport or covered). */
async function shot(page, file, { names = [], scrolls = false } = {}){
  // From the top, as the screen first shows: a click on Pause scrolls a long page down to it.
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(500);
  const got = await page.evaluate(names => {
    const spill = document.documentElement.scrollHeight - innerHeight;
    const els = [...document.querySelectorAll("main *")].filter(el => !el.closest("[aria-hidden=true]"));
    const right = Math.max(0, ...els.map(el => el.getBoundingClientRect().right));
    const seen = n => els.filter(el => !el.children.length && el.textContent === n).some(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || r.top < 0 || r.left < 0 || r.bottom > innerHeight + 1 || r.right > innerWidth + 1) return false;
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!at && (at === el || el.contains(at));
    });
    return { spill, wide: right - innerWidth, unseen: names.filter(n => !seen(n)) };
  }, names);
  const size = page.viewportSize();
  console.log(`${file}: ${size.width}x${size.height}, page ${got.spill > 0 ? `scrolls ${got.spill}px` : "fits"}, ${got.unseen.length ? `${got.unseen.length} of ${names.length} names off screen` : `${names.length} names on screen`}`);
  if (got.spill > 1 && !scrolls) problems.push(`${file} scrolls ${got.spill}px`);
  if (got.wide > 1) problems.push(`${file} runs ${Math.round(got.wide)}px past the right edge`);
  if (got.unseen.length) problems.push(`${file}: ${got.unseen.length} names off screen (${got.unseen.slice(0, 4).join(", ")}${got.unseen.length > 4 ? ", ..." : ""})`);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${file}.png`) });
}
/* The host screen at both sizes, back to the big screen after. lobby: at
   390px it may scroll, so its names may be below the fold. */
async function both(page, n, name, { names = [], lobby = false } = {}){
  await shot(page, `${n}/host-1920-${name}`, { names });
  await page.setViewportSize(SMALL);
  await shot(page, `${n}/host-390-${name}`, lobby ? { scrolls: true } : { names });
  await page.setViewportSize(BIG);
}

const hostBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] });
const phoneBrowser = await webkit.launch();
const errors = [];
let exit = 0;

async function party(n){
  if (shotsDir) fs.mkdirSync(path.join(shotsDir, String(n)), { recursive: true });
  const names = NAMES.slice(0, n);
  const hostCtx = await hostBrowser.newContext({ viewport: BIG, reducedMotion: "reduce" });
  const phoneCtx = await phoneBrowser.newContext({ ...devices["iPhone 13"], viewport: SMALL, reducedMotion: "reduce" });
  for (const c of [hostCtx, phoneCtx]){
    await wireWorker(c, worker.origin, origin, []);
    await c.addInitScript(silence);
    await c.addInitScript(skipLanding);
  }
  const host = await hostCtx.newPage();
  const phone = await phoneCtx.newPage();
  for (const [p, label] of [[host, "host"], [phone, "phone"]]){
    p.on("pageerror", e => errors.push(`${n} ${label}: ${e.message}`));
    p.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errors.push(`${n} ${label}: ${m.text()}`); });
  }
  const hostShow = () => host.evaluate(() => JSON.parse(localStorage.getItem("tt_room_host") || "null"));
  let raws = [];
  try {
    await host.goto(url);
    await host.getByRole("radio", { name: "Buzz in" }).click();
    await moreSettings(host);
    await host.getByRole("radio", { name: "3", exact: true }).click();
    await host.getByRole("button", { name: "Open a room" }).click();
    await host.getByText("Doors open").waitFor({ timeout: 20000 });
    const code = (await hostShow()).code;

    // The phone takes the third seat and never scores, so its own row sits low on the final list.
    const phoneName = names[2];
    raws = names.filter(x => x !== phoneName).map(x => rawSeat(code, x));
    await phone.goto(url + "#room=" + code);
    await phone.getByLabel("Your name").fill(phoneName);
    await phone.getByRole("button", { name: "Join the show" }).click();
    await phone.getByText("You're in").waitFor({ timeout: 15000 });
    const view = () => raws[0].view;
    await until(`${n} seats`, () => view()?.players.length === n && raws.every(r => r.id));
    await host.getByText(`${n} in`).waitFor();
    await host.getByRole("button", { name: "Wait for everyone" }).click();
    await both(host, n, "01-lobby", { names, lobby: true });
    await host.getByRole("button", { name: "Start the show" }).click();

    const song = () => view()?.song;
    const live = k => until(`song ${k} live`, async () => {
      if (song()?.n === k && song().state === "live") return true;
      if (await host.getByText(/won't stream right now|isn't available/).isVisible().catch(() => false))
        await host.getByRole("button", { name: "Skip this song" }).click({ timeout: 1500 }).catch(() => {});
      return false;
    }, 60000);
    const title = async () => { const s = await hostShow(); return displayTitle(s.queue[s.idx].title); };
    const answering = (k, seat) => until(`${seat.name} answering song ${k}`, () => song()?.n === k && song().answering === seat.id);
    const next = async label => {
      const btn = host.getByRole("button", { name: label });
      await btn.click({ timeout: 20000 });
      await btn.waitFor({ state: "detached" });
    };

    // A spread of scores: a few seats win often, most never.
    const winners = [0, 1, 0, 2, 0, 1, 3, 4, 0, 5, 6, 1];
    const total = (await until("the show", async () => { const s = await hostShow(); return s?.started && s.queue.length ? s : null; }, 60000)).total;
    for (let k = 1; k <= total; k++){
      await live(k);
      const won = raws[winners[(k - 1) % winners.length] % raws.length];
      if (k === 1){
        // Song 1: one seat says something wrong, the winner answers, another waits in line.
        const wrong = raws[(raws.indexOf(won) + 2) % raws.length], queued = raws[(raws.indexOf(won) + 1) % raws.length];
        for (const s of [wrong, won, queued]){ s.send({ t: "buzz" }); await sleep(150); }
        await answering(k, wrong);
        await until("the line", () => song().queue.length === 3);
        wrong.send({ t: "answer", text: "xq zv" });
        await answering(k, won);
        await host.getByText("On the buzzer").waitFor();
        await both(host, n, "02-song", { names });
      } else {
        won.send({ t: "buzz" });
        await answering(k, won);
      }
      won.send({ t: "answer", text: await title() });
      await until(`song ${k} revealed`, () => song()?.n === k && song().state === "revealed");
      const last = k === total, board = last || k % 4 === 0;
      const label = last ? "Final box office" : board ? "To the box office" : "Next song";
      await host.getByRole("button", { name: label }).waitFor({ timeout: 20000 });
      if (k === 1){
        await host.getByRole("button", { name: "Pause" }).click();
        await both(host, n, "03-reveal");
      }
      await next(label);
      if (!board) continue;
      await host.getByText(last ? "Final count" : `After round ${k / 4}`).waitFor();
      if (k === 4 || last){
        // Shot once the rows have settled into rank order, held so the board stays up.
        await host.getByRole("button", { name: "Pause" }).click();
        await host.waitForTimeout(1200);
        await both(host, n, last ? "05-final-count" : "04-box-office", { names });
      }
      await next(last ? "Roll the credits" : `On to round ${k / 4 + 1}`);
    }
    await host.getByRole("button", { name: "Same crowd again" }).waitFor({ timeout: 20000 });
    await both(host, n, "06-podium", { names });
    await phone.getByText("That's the show").waitFor({ timeout: 15000 });
    await shot(phone, `${n}/phone-390-07-final`, { names });
  } catch (e){
    if (shotsDir){
      await host.screenshot({ path: path.join(shotsDir, `${n}/fail-host.png`) }).catch(() => {});
      await phone.screenshot({ path: path.join(shotsDir, `${n}/fail-phone.png`) }).catch(() => {});
    }
    throw e;
  } finally {
    for (const r of raws) r.close();
    await hostCtx.close().catch(() => {});
    await phoneCtx.close().catch(() => {});
  }
}

try {
  for (const n of counts) await party(n);
  if (problems.length) fail("screens that do not fit:\n" + problems.join("\n"));
  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  console.log(`room-crowd: PASS (${counts.join(", ")} seats)`);
} catch (e){
  console.error("room-crowd: FAIL", e.message);
  exit = 1;
} finally {
  await hostBrowser.close().catch(() => {});
  await phoneBrowser.close().catch(() => {});
  server.close();
  worker.stop();
}
process.exit(exit);
