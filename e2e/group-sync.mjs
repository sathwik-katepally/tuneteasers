/* Two phones in one group, the way a party uses it: desktop Chromium makes a
   group (importing its own song history), phone WebKit joins through the
   #join link, desktop plays a show, and then:
   - the phone's next crate fetched the desktop's plays and left them out,
   - the desktop's finished show is in the phone's Past shows,
   - a song the phone plays is left out of the desktop's next crate,
   - with the Worker unreachable the phone still plays, queues its plays, and
     sends them once the Worker is back.
   The deployed Worker host is rerouted to a local `wrangler dev` with a fresh
   D1 (started here), or to --worker=<origin> (e.g. the preview deployment).
   node e2e/group-sync.mjs [--worker=https://...] [--shots=dir] */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { serve, open, args, saved } from "./harness.mjs";
import { songKey } from "../src/lib/utils.js";

const A = args({});
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";
const WORKER_DIR = path.resolve(import.meta.dirname, "../worker");

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function localWorker(){
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "tt-group-e2e-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: WORKER_DIR, stdio: "ignore" });
  const [port, inspector] = [await freePort(), await freePort()];
  const proc = spawn("npx", ["wrangler", "dev", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persist], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + out.slice(-800))), 60000);
    const read = d => { out += d; if (/Ready on/.test(out)){ clearTimeout(timer); resolve(); } };
    proc.stdout.on("data", read); proc.stderr.on("data", read);
    proc.on("exit", code => reject(new Error(`wrangler dev exited ${code}:\n${out.slice(-800)}`)));
  });
  return { origin: `http://localhost:${port}`, stop: () => { proc.kill(); fs.rmSync(persist, { recursive: true, force: true }); } };
}

const worker = A.worker ? { origin: A.worker.replace(/\/$/, ""), stop(){} } : await localWorker();
const server = await serve();
const url = server.url;
const phone = await open("phone");
const desktop = await open("desktop");
const fail = msg => { throw new Error(msg); };
const seen = { phonePlayed: null };

async function wire(dev, label, { down = false } = {}){
  await dev.context.unrouteAll({ behavior: "ignoreErrors" });
  await dev.context.route(u => u.host === WORKER_HOST, async route => {
    if (down) return route.abort("connectionrefused");
    const u = new URL(route.request().url());
    try {
      const res = await route.fetch({ url: worker.origin + u.pathname + u.search });
      if (label === "phone" && u.pathname === "/api/group/played") seen.phonePlayed = await res.json().catch(() => null);
      return route.fulfill({ response: res });
    } catch { return route.abort(); }
  });
}

async function shot(dev, name){
  if (!shotsDir) return;
  await dev.page.waitForTimeout(350);
  await dev.page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });
}

async function api(invite, p){
  const r = await fetch(worker.origin + "/api" + p, { headers: { authorization: `Bearer ${invite}` } });
  if (!r.ok) fail(`GET ${p} -> ${r.status}`);
  return r.json();
}

async function setupShow(page){
  await page.getByRole("radio", { name: "Solo" }).click();
  await page.getByRole("radio", { name: "Easy", exact: true }).click();
  await page.getByRole("radio", { name: "3", exact: true }).click();
  while (await page.getByRole("button", { name: /^Remove / }).count()) await page.getByRole("button", { name: /^Remove / }).first().click();
}

/* Plays `turns` turns (all, when null) from the current handover. Returns the
   titles that were marked played (judged or skipped). */
async function play(page, turns = null){
  const played = [];
  const btn = name => page.getByRole("button", { name });
  for (let n = 0, guard = 0; guard < 40; guard++){
    const handover = page.getByRole("button", { name: /^It's with me|roll it$/ });
    const board = page.getByRole("button", { name: /On to round|Roll the credits/ });
    const podium = btn("Same crowd again");
    await Promise.race([handover.waitFor(), board.waitFor(), podium.waitFor()].map(p => p.catch(() => {})));
    if (await podium.isVisible()) break;
    if (await board.isVisible()){ await board.click(); await board.waitFor({ state: "detached" }); continue; }
    if (turns !== null && n >= turns) break;
    await handover.click();
    const nope = btn("I don't know this one");
    await nope.waitFor({ timeout: 30000 });
    for (let tries = 0; ; tries++){
      const dead = page.getByText("This song won't stream right now");
      await Promise.race([
        page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "I don't know this one" && !b.disabled), null, { timeout: 30000 }),
        dead.waitFor({ timeout: 30000 }),
      ]).catch(() => {});
      if (!(await dead.isVisible())) break;
      if (tries === 2) fail("three dead streams in a row");
      const g = (await saved(page)).game;
      played.push(g.queue[g.trackIdx].title);
      await btn("Skip this song").click();
    }
    const g = (await saved(page)).game;
    played.push(g.queue[g.trackIdx].title);
    await nope.click();
    const next = page.getByRole("button", { name: /Pass it on|box office/ });
    await next.waitFor();
    await next.click();
    await next.waitFor({ state: "detached" });
    n++;
  }
  return played;
}

const outbox = page => page.evaluate(() => JSON.parse(localStorage.getItem("tt_group_outbox") || "null"));
const pendingCount = async page => { const o = await outbox(page); return o ? o.rounds.length + o.results.length : 0; };
const waitSynced = page => page.waitForFunction(() => {
  const o = JSON.parse(localStorage.getItem("tt_group_outbox") || "null");
  return !o || o.rounds.length + o.results.length === 0;
}, null, { timeout: 20000 });

let exit = 0;
try {
  await wire(desktop, "desktop");
  await wire(phone, "phone");

  // Desktop: an existing phone with its own history makes the group.
  const importKey = "group sync import probe";
  await desktop.page.goto(url + "seed.html");
  await desktop.page.evaluate(k => { localStorage.clear(); localStorage.setItem("tt_played", JSON.stringify({ [k]: Date.now() - 3600e3 })); }, importKey);
  await desktop.page.goto(url);
  await desktop.page.getByText("More than one phone?").waitFor();
  await shot(desktop, "desktop-01-no-group");
  await desktop.page.getByRole("button", { name: "Make a group" }).click();
  await desktop.page.getByLabel("Group name").fill("Friday night crew");
  const importBox = desktop.page.getByRole("checkbox");
  if (!(await importBox.isChecked())) fail("history import is not offered by default");
  await shot(desktop, "desktop-02-create");
  await desktop.page.getByRole("button", { name: "Make it" }).click();
  const linkBox = desktop.page.getByLabel("Invite link");
  await linkBox.waitFor();
  await desktop.page.getByRole("img", { name: "Invite QR code" }).waitFor();
  await shot(desktop, "desktop-03-invite");
  const link = await linkBox.inputValue();
  const invite = (/#join=(.+)$/.exec(link) || [])[1];
  if (!invite) fail(`no invite in link ${link}`);
  const group = JSON.parse(await desktop.page.evaluate(() => localStorage.getItem("tt_group")));
  if (!group.owner) fail("maker has no owner secret");
  if ((await api(invite, "/group")).role !== "member") fail("invite link carries more than member rights");
  const imported = (await api(invite, "/group/played")).played;
  if (!imported[importKey]) fail("local history was not imported");
  await desktop.page.getByRole("button", { name: "Done" }).click();
  await desktop.page.getByText("Friday night crew").waitFor();

  // Phone: opens the shared link.
  await phone.page.goto(url + "seed.html");
  await phone.page.evaluate(() => localStorage.clear());
  await phone.page.goto(url + "#join=" + invite);
  await phone.page.getByText("You're invited").waitFor();
  await phone.page.getByText("Friday night crew").waitFor();
  if ((await phone.page.evaluate(() => location.hash)) !== "") fail("invite left in the address bar");
  await shot(phone, "phone-01-invited");
  await phone.page.getByRole("button", { name: "Join", exact: true }).click();
  await phone.page.getByText("Your group").waitFor();
  await phone.page.getByText("In sync").waitFor();
  await shot(phone, "phone-02-joined");
  await phone.page.getByRole("button", { name: "Invite", exact: true }).click();
  await phone.page.getByRole("img", { name: "Invite QR code" }).waitFor();
  if ((await phone.page.getByLabel("Invite link").inputValue()) !== link) fail("phone shares a different invite link");
  await shot(phone, "phone-02b-invite");
  await phone.page.getByRole("button", { name: "Done" }).click();
  const phoneGroup = JSON.parse(await phone.page.evaluate(() => localStorage.getItem("tt_group")));
  if (phoneGroup.owner) fail("joining phone got the owner secret");

  // Desktop plays a whole 3-song show.
  await setupShow(desktop.page);
  await desktop.page.getByRole("button", { name: /Start the show/ }).click();
  const desktopPlayed = await play(desktop.page);
  await desktop.page.getByRole("button", { name: "Same crowd again" }).waitFor();
  await waitSynced(desktop.page);
  const desktopKeys = desktopPlayed.map(songKey);
  const groupPlayed1 = (await api(invite, "/group/played")).played;
  const missing = desktopKeys.filter(k => !groupPlayed1[k]);
  if (missing.length) fail(`desktop plays not in the group: ${missing.join(", ")}`);
  const results1 = (await api(invite, "/group/results")).results;
  if (results1.length !== 1) fail(`expected 1 result, got ${results1.length}`);
  const desktopScore = (await saved(desktop.page)).game.cast[0];

  // Phone: Past shows lists the desktop's show.
  await phone.page.getByRole("button", { name: "Past shows" }).click();
  await phone.page.getByRole("heading", { name: "Past shows" }).waitFor();
  const row = phone.page.locator("li", { hasText: desktopScore.name }).first();
  await row.waitFor();
  const rowText = await row.innerText();
  if (!rowText.includes(String(desktopScore.score))) fail(`past show row "${rowText}" lacks score ${desktopScore.score}`);
  if (!/Solo · Easy · Hindi \+ Telugu · 3 rounds/.test(await phone.page.locator("body").innerText())) fail("past show settings line wrong");
  await shot(phone, "phone-03-past-shows");
  await phone.page.getByRole("button", { name: "Back to the booking counter" }).click();

  // Phone: its next crate left out every song the desktop played.
  await setupShow(phone.page);
  seen.phonePlayed = null;
  await phone.page.getByRole("button", { name: /Start the show/ }).click();
  await phone.page.getByRole("button", { name: /^It's with me/ }).waitFor({ timeout: 60000 });
  if (!seen.phonePlayed) fail("phone did not fetch the group's cooldown before its crate");
  const fetched = desktopKeys.filter(k => !seen.phonePlayed.played[k]);
  if (fetched.length) fail(`phone's cooldown fetch lacked ${fetched.join(", ")}`);
  const phoneQueue = (await saved(phone.page)).game.queue.map(t => songKey(t.title));
  const repeats = phoneQueue.filter(k => desktopKeys.includes(k) || k === importKey);
  if (repeats.length) fail(`phone's crate repeats desktop songs: ${repeats.join(", ")}`);

  // Phone plays one song; the desktop's next crate leaves it out.
  const phonePlayed = await play(phone.page, 1);
  await waitSynced(phone.page);
  const phoneKeys = phonePlayed.map(songKey);
  const groupPlayed2 = (await api(invite, "/group/played")).played;
  if (phoneKeys.some(k => !groupPlayed2[k])) fail("phone play not in the group");
  await desktop.page.getByRole("button", { name: "New show" }).click();
  await setupShow(desktop.page);
  await desktop.page.getByRole("button", { name: /Start the show/ }).click();
  await desktop.page.getByRole("button", { name: /^It's with me/ }).waitFor({ timeout: 60000 });
  const desktopQueue = (await saved(desktop.page)).game.queue.map(t => songKey(t.title));
  const back = desktopQueue.filter(k => phoneKeys.includes(k) || desktopKeys.includes(k));
  if (back.length) fail(`desktop's crate repeats group songs: ${back.join(", ")}`);

  // Phone with the Worker unreachable: the show goes on, plays wait in the outbox.
  await phone.page.getByRole("button", { name: "Game menu" }).click();
  await phone.page.getByRole("button", { name: "End game" }).click();
  await phone.page.getByRole("button", { name: "End it" }).click();
  await wire(phone, "phone", { down: true });
  await phone.page.reload();
  await setupShow(phone.page);
  await phone.page.getByRole("button", { name: /Start the show/ }).click();
  await phone.page.getByRole("button", { name: /^It's with me/ }).waitFor({ timeout: 90000 });
  const offlineSource = (await saved(phone.page)).game.source;
  const offlinePlayed = await play(phone.page, 1);
  if ((await pendingCount(phone.page)) < offlinePlayed.length) fail("offline plays were not queued");
  await phone.page.getByRole("button", { name: "Game menu" }).click();
  await phone.page.getByRole("button", { name: "Home, keep the game" }).click();
  await phone.page.getByText(/waiting to sync/).waitFor();
  await shot(phone, "phone-04-offline-pending");
  await wire(phone, "phone");
  await phone.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitSynced(phone.page);
  await phone.page.getByText("In sync").waitFor();
  const groupPlayed3 = (await api(invite, "/group/played")).played;
  if (offlinePlayed.map(songKey).some(k => !groupPlayed3[k])) fail("queued offline play never reached the group");

  // Owner deletes the group; the phone sees its invite stop working.
  await desktop.page.getByRole("button", { name: "Game menu" }).click();
  await desktop.page.getByRole("button", { name: "End game" }).click();
  await desktop.page.getByRole("button", { name: "End it" }).click();
  await desktop.page.getByRole("button", { name: "Leave this group" }).click();
  await desktop.page.getByRole("button", { name: "Delete the group for every phone" }).click();
  await shot(desktop, "desktop-04-delete-confirm");
  await desktop.page.getByRole("button", { name: "Delete", exact: true }).click();
  await desktop.page.getByText("More than one phone?").waitFor();
  const gone = await fetch(worker.origin + "/api/group", { headers: { authorization: `Bearer ${invite}` } });
  if (gone.status !== 403) fail(`deleted group answered ${gone.status}`);
  await phone.page.getByRole("button", { name: "Past shows" }).click();
  await phone.page.getByRole("alert").waitFor();
  await phone.page.getByRole("button", { name: "Back to the booking counter" }).click();

  const errors = [...phone.errors, ...desktop.errors];
  if (errors.length) fail("page errors: " + errors.join(" | "));
  console.log("PASS group-sync", `worker=${A.worker ? worker.origin : "local wrangler dev"}`,
    `desktop=${desktopKeys.length} songs, phone crate ${phoneQueue.length} tracks with 0 repeats, past show ${desktopScore.name}=${desktopScore.score}, offline source=${offlineSource}`);
} catch (e){
  exit = 1;
  console.log("FAIL group-sync", e.message.split("\n").slice(0, 8).join(" / "));
  if (shotsDir){
    await phone.page.screenshot({ path: path.join(shotsDir, "phone-FAIL.png") }).catch(() => {});
    await desktop.page.screenshot({ path: path.join(shotsDir, "desktop-FAIL.png") }).catch(() => {});
  }
} finally {
  await phone.browser.close();
  await desktop.browser.close();
  server.close();
  worker.stop();
  process.exit(exit);
}
