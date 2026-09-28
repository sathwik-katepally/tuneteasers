/* Personal tickets (docs/tickets.md) the way a group of friends uses them:
   - Asha makes a ticket on her phone with a passkey (a virtual authenticator;
     WebKit has none, so her phone is Chromium at iPhone size), importing the
     phone's history, and joins a group;
   - Ravi's WebKit phone in the same group picks Asha from the roster chips
     and plays a show: every song is recorded for Asha;
   - the group maker's desktop, with Asha in its roster, gets a crate without
     any of those songs;
   - Asha joins a buzz-in room from her phone; the host's crate leaves her
     history out and a revealed song lands in her history;
   - a fresh browser recovers the ticket with the passkey (the old phone's
     ticket stops working), moves it to a WebKit phone by link, plays with the
     Worker unreachable, then deletes it;
   - the Worker refuses wrong or missing keys, forged assertions, foreign
     origins, oversize input and too many new tickets, and never sees a
     ticket in a URL.
   The deployed Worker host is rerouted to a local `wrangler dev` with a fresh
   D1 (started here), or to --worker=<origin>.
   node e2e/tickets.mjs [--worker=https://...] [--shots=dir] */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { serve, args, saved, localWorker, silence, skipLanding, MUTE_ARGS } from "./harness.mjs";
import { songKey } from "../src/lib/utils.js";

const A = args({});
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";
const TICKET_RX = /[a-z2-7]{12}\.[A-Za-z0-9_-]{22}/;

const worker = A.worker ? { origin: A.worker.replace(/\/$/, ""), stop(){} } : await localWorker();
// wrangler dev bundles on its first request, which the app's 5 s timeout would cut short.
await fetch(worker.origin + "/health").catch(() => {});
const server = await serve();
const url = server.url;
const origin = new URL(url).origin;
const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const latest = {};
const urlsSeen = [];

/* Every device talks to the local Worker; the proxy also records each URL so
   the run can prove no ticket ever travelled in one. */
async function wire(dev, { down = false } = {}){
  const { context, label } = dev;
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.route(u => u.host === WORKER_HOST, async route => {
    const u = new URL(route.request().url());
    urlsSeen.push(u.pathname + u.search);
    if (u.pathname === "/api/group/played") dev.playedQueries.push(u.search);
    if (down) return route.abort("connectionrefused");
    try {
      const res = await route.fetch({ url: worker.origin + u.pathname + u.search });
      return route.fulfill({ response: res });
    } catch { return route.abort(); }
  });
  await context.routeWebSocket(u => u.host === WORKER_HOST, ws => {
    const u = new URL(ws.url());
    urlsSeen.push(u.pathname + u.search);
    if (down){ ws.close({ code: 1006 }); return; }
    const up = new WebSocket(worker.origin.replace(/^http/, "ws") + u.pathname + u.search, { headers: { origin } });
    const pending = [];
    up.onopen = () => { for (const m of pending.splice(0)) up.send(m); };
    up.onmessage = e => {
      const data = String(e.data);
      try { const m = JSON.parse(data); if (m.t === "state") latest[label] = m; } catch {}
      ws.send(data);
    };
    up.onclose = e => { try { ws.close({ code: e.code >= 4000 ? e.code : 1000, reason: e.reason }); } catch {} };
    ws.onMessage(m => { const data = String(m); if (up.readyState === 1) up.send(data); else pending.push(data); });
    ws.onClose(() => { try { up.close(); } catch {} });
  });
}

/* kind: "phone" (WebKit iPhone), "desktop" (Chromium 1440x900), or
   "passkey-phone" (Chromium at iPhone size with a virtual authenticator). */
async function device(kind, label){
  const desk = kind === "desktop";
  const browser = kind === "phone" ? await webkit.launch() : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] });
  const context = await browser.newContext(desk ? { viewport: { width: 1440, height: 900 } } : { ...devices["iPhone 13"] });
  await context.addInitScript(silence);
  await context.addInitScript(skipLanding);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(`${label}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  const dev = { label, browser, context, page, errors, playedQueries: [], cdp: null, authenticatorId: null };
  if (kind === "passkey-phone"){
    dev.cdp = await context.newCDPSession(page);
    await dev.cdp.send("WebAuthn.enable");
    const r = await dev.cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    dev.authenticatorId = r.authenticatorId;
  }
  await wire(dev);
  return dev;
}

const overflow = [];
async function shot(dev, name){
  await dev.page.waitForTimeout(350);
  if (shotsDir) await dev.page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true });
}

async function api(method, p, { token, body } = {}){
  const r = await fetch(worker.origin + "/api" + p, {
    method, headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, data };
}
const meOf = page => page.evaluate(() => JSON.parse(localStorage.getItem("tt_me") || "null"));
const clearStorage = async (page, seed = {}) => {
  await page.goto(url + "seed.html");
  await page.evaluate(s => { localStorage.clear(); localStorage.setItem("tt_landing_seen", "1"); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v)); }, seed);
};

async function setupShow(page){
  await page.getByRole("radio", { name: "Pass the phone" }).click();
  await page.getByRole("radio", { name: "Solo" }).click();
  await page.getByRole("radio", { name: "Easy", exact: true }).click();
  await page.getByRole("radio", { name: "3", exact: true }).click();
  while (await page.getByRole("button", { name: /^Remove / }).count()) await page.getByRole("button", { name: /^Remove / }).first().click();
}

/* Plays `turns` turns (all, when null) from the current handover; returns the titles marked played. */
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
const waitSynced = page => page.waitForFunction(() => {
  const g = JSON.parse(localStorage.getItem("tt_group_outbox") || "null");
  const m = JSON.parse(localStorage.getItem("tt_me_outbox") || "null");
  return (!g || g.rounds.length + g.results.length === 0) && (!m || m.rounds.length + (m.prefs ? 1 : 0) === 0);
}, null, { timeout: 20000 });
const until = async (what, fn, timeout = 30000) => {
  const t0 = Date.now();
  for (;;){ const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) fail(`timed out waiting for ${what}`); await sleep(150); }
};

const asha = await device("passkey-phone", "asha");
const ravi = await device("phone", "ravi");
const maker = await device("desktop", "maker");
const all = [asha, ravi, maker];
let exit = 0;
try {
  // The group maker's desktop.
  await clearStorage(maker.page);
  await maker.page.goto(url);
  await maker.page.getByRole("button", { name: "Make a group" }).click();
  await maker.page.getByLabel("Group name").fill("Friday crew");
  await maker.page.getByRole("button", { name: "Make it" }).click();
  const linkBox = maker.page.getByLabel("Invite link");
  await linkBox.waitFor();
  const inviteLink = await linkBox.inputValue();
  const invite = (/#join=(.+)$/.exec(inviteLink) || [])[1] || fail("no invite link");
  await maker.page.getByRole("button", { name: "Done" }).click();

  // Asha's phone has a history of its own; the ticket imports it.
  const importKey = "ticket import probe";
  await clearStorage(asha.page, { tt_played: { [importKey]: Date.now() - 3600e3 }, tt_blocked: ["Probe Singer"] });
  await asha.page.goto(url);
  await asha.page.getByText("Your ticket").waitFor();
  await shot(asha, "asha-01-no-ticket");
  await asha.page.getByRole("button", { name: "Make my ticket" }).click();
  await asha.page.getByLabel("Your name").fill("Asha");
  const bring = asha.page.getByRole("checkbox");
  if (!(await bring.isChecked())) fail("history import is not offered by default");
  if (!/1 recent songs and 1 blocked artist/.test(await asha.page.getByText(/Bring this phone/).innerText())) fail("import line does not count history and blocked artists");
  await shot(asha, "asha-02-make");
  await asha.page.getByRole("button", { name: "Make my ticket" }).click();
  await asha.page.getByText("Passkey saved").waitFor({ timeout: 20000 });
  await shot(asha, "asha-03-ticket");
  // A phone that never played and has no group is not asked for a ticket yet; Asha's was.
  const ashaRoster = (await saved(asha.page)).players;
  if (ashaRoster[0].name !== "Asha" || !ashaRoster[0].people?.length) fail(`ticket holder did not take Player 1's place: ${JSON.stringify(ashaRoster)}`);
  const ashaMe = await meOf(asha.page);
  if (!ashaMe?.ticket || !TICKET_RX.test(ashaMe.ticket) || ashaMe.name !== "Asha") fail(`bad tt_me ${JSON.stringify(ashaMe)}`);
  const ashaId = ashaMe.id;
  let me = await api("GET", "/me", { token: ashaMe.ticket });
  if (me.status !== 200 || me.data.passkeys !== 1) fail(`ticket after passkey: ${me.status} ${JSON.stringify(me.data)}`);
  if (!me.data.prefs?.blocked?.includes("Probe Singer")) fail("blocked artists were not imported");
  const imported = await api("GET", "/me/played", { token: ashaMe.ticket });
  if (!imported.data.played[importKey]) fail("phone history was not imported onto the ticket");
  const creds = await asha.cdp.send("WebAuthn.getCredentials", { authenticatorId: asha.authenticatorId });
  if (creds.credentials.length !== 1 || !creds.credentials[0].isResidentCredential) fail(`expected one resident passkey, got ${JSON.stringify(creds.credentials.map(c => c.isResidentCredential))}`);

  // Asha joins the group; her ticket joins it too.
  await asha.page.goto(url + "#join=" + invite);
  await asha.page.getByText("You're invited").waitFor();
  await asha.page.getByRole("button", { name: "Join", exact: true }).click();
  await asha.page.getByText("Your group", { exact: true }).waitFor();
  await until("Asha in the group's people", async () => (await api("GET", "/group/people", { token: invite })).data.people.some(p => p.id === ashaId));
  if ((await asha.page.evaluate(() => location.hash)) !== "") fail("invite left in the address bar");

  // Ravi's phone joins the group and plays a show with Asha on the roster.
  await clearStorage(ravi.page);
  await ravi.page.goto(url);
  await ravi.page.getByText("Tonight's show").waitFor();
  if (await ravi.page.getByLabel("Ticket", { exact: true }).count()) fail("a phone that never played is asked for a ticket");
  await ravi.page.goto(url + "#join=" + invite);
  await ravi.page.getByText("You're invited").waitFor();
  await ravi.page.getByRole("button", { name: "Join", exact: true }).click();
  await ravi.page.getByText("Your group", { exact: true }).waitFor();
  await setupShow(ravi.page);
  const ashaChip = ravi.page.getByRole("button", { name: "Add Asha with their ticket" });
  await ashaChip.waitFor({ timeout: 10000 });
  await shot(ravi, "ravi-01-roster-chips");
  await ashaChip.click();
  await ravi.page.getByRole("button", { name: "Add", exact: true }).click();
  await ravi.page.keyboard.type("Ravi"); await ravi.page.keyboard.press("Enter");
  await ravi.page.getByRole("img", { name: "Has a ticket" }).waitFor();
  if (await ashaChip.count()) fail("Asha is still offered after being added");
  await shot(ravi, "ravi-02-roster");
  const raviRoster = (await saved(ravi.page)).players;
  if (!raviRoster.find(p => p.name === "Asha")?.people?.includes(ashaId)) fail(`roster entry not linked: ${JSON.stringify(raviRoster)}`);
  await ravi.page.getByRole("button", { name: /Start the show/ }).click();
  const raviPlayed = await play(ravi.page);
  await ravi.page.getByRole("button", { name: "Same crowd again" }).waitFor();
  await waitSynced(ravi.page);
  const raviKeys = raviPlayed.map(songKey);
  if (raviKeys.length < 6) fail(`Ravi's show played only ${raviKeys.length} songs`);
  const ashaHistory = (await api("GET", "/me/played", { token: ashaMe.ticket })).data.played;
  const missing = raviKeys.filter(k => !ashaHistory[k]);
  if (missing.length) fail(`songs played on Ravi's phone missing from Asha's ticket: ${missing.join(", ")}`);
  const raviQuery = ravi.playedQueries.find(q => q.includes(ashaId));
  if (!raviQuery) fail(`Ravi's cooldown read did not name Asha: ${ravi.playedQueries.join(" ")}`);

  // The maker's desktop, opened again with Asha in its roster: none of those songs come up.
  await maker.page.reload();
  await maker.page.getByText("Your group", { exact: true }).waitFor();
  await setupShow(maker.page);
  await maker.page.getByRole("button", { name: "Add Asha with their ticket" }).click();
  maker.playedQueries.length = 0;
  await maker.page.getByRole("button", { name: /Start the show/ }).click();
  await maker.page.getByRole("button", { name: /^It's with me/ }).waitFor({ timeout: 60000 });
  const makerQueue = (await saved(maker.page)).game.queue.map(t => songKey(t.title));
  const repeats = makerQueue.filter(k => raviKeys.includes(k) || k === importKey);
  if (repeats.length) fail(`maker's crate repeats Asha's songs: ${repeats.join(", ")}`);
  if (!maker.playedQueries.some(q => q.includes(ashaId))) fail("maker's cooldown read did not name Asha");
  await maker.page.getByRole("button", { name: "Game menu" }).click();
  await maker.page.getByRole("button", { name: "End game" }).click();
  await maker.page.getByRole("button", { name: "End it" }).click();

  // A buzz-in room: the host has no group and no ticket, Asha joins with hers.
  const host = await device("desktop", "host");
  all.push(host);
  await clearStorage(host.page);
  await host.page.goto(url);
  await host.page.getByRole("radio", { name: "Buzz in" }).click();
  await host.page.getByRole("radio", { name: "Easy", exact: true }).click();
  await host.page.getByRole("radio", { name: "3", exact: true }).click();
  await host.page.getByRole("button", { name: "Open a room" }).click();
  await host.page.getByText("Doors open").waitFor({ timeout: 20000 });
  const hostShow = () => host.page.evaluate(() => JSON.parse(localStorage.getItem("tt_room_host") || "null"));
  const code = (await hostShow()).code;
  await asha.page.goto(url + "#room=" + code);
  const nameBox = asha.page.getByLabel("Your name");
  if ((await nameBox.inputValue()) !== "Asha") fail("ticket name not offered on the room join form");
  await asha.page.getByText("Your ticket comes with you").waitFor();
  await shot(asha, "asha-04-room-join");
  await asha.page.getByRole("button", { name: "Join the show" }).click();
  await asha.page.getByText("You're in").waitFor({ timeout: 15000 });
  await host.page.getByRole("img", { name: "Has a ticket" }).waitFor({ timeout: 10000 });
  await shot(host, "host-01-lobby-ticket");
  await until("room knows the ticket", () => latest.host?.players?.[0]?.ticket === true);
  await host.page.getByRole("button", { name: "Start the show" }).click();
  const show = await until("host queue", async () => { const s = await hostShow(); return s?.started && s.queue.length ? s : null; }, 60000);
  const roomRepeats = show.queue.map(t => songKey(t.title)).filter(k => raviKeys.includes(k) || k === importKey);
  if (roomRepeats.length) fail(`host's crate repeats Asha's songs: ${roomRepeats.join(", ")}`);
  if (!urlsSeen.some(u => u === `/api/rooms/${code}/history`)) fail("host did not ask for the seated histories");
  // Nobody buzzes; the host reveals the first song, which lands in Asha's history.
  await until("song 1 live", () => latest.host?.song?.n === 1 && latest.host.song.state === "live", 45000);
  const first = songKey((await hostShow()).queue[0].title);
  await host.page.getByRole("button", { name: "Reveal it" }).click();
  await host.page.getByRole("button", { name: /Next song|box office/ }).waitFor({ timeout: 20000 });
  await until("Asha's history has the room's song", async () => (await api("GET", "/me/played", { token: ashaMe.ticket })).data.played[first]);
  await shot(asha, "asha-05-room-reveal");
  await host.page.getByRole("button", { name: "Game menu" }).click();
  await host.page.getByRole("button", { name: "End game" }).click();
  await host.page.getByRole("button", { name: "End it" }).click();

  // A new phone recovers the ticket with the passkey; Asha's old phone loses it.
  const fresh = await device("passkey-phone", "fresh");
  all.push(fresh);
  const cred = creds.credentials[0];
  await fresh.cdp.send("WebAuthn.addCredential", { authenticatorId: fresh.authenticatorId, credential: cred });
  await clearStorage(fresh.page);
  await fresh.page.goto(url);
  await fresh.page.getByRole("button", { name: "Already have a ticket?" }).click();
  await shot(fresh, "fresh-01-recover");
  await fresh.page.getByRole("button", { name: "Use my passkey" }).click();
  await fresh.page.getByText("Passkey saved").waitFor({ timeout: 20000 });
  await fresh.page.getByLabel("Ticket", { exact: true }).getByText("Asha").waitFor();
  const freshMe = await meOf(fresh.page);
  if (freshMe.id !== ashaId || freshMe.ticket === ashaMe.ticket) fail("recovery did not hand over the ticket with a new key");
  if ((await api("GET", "/me", { token: ashaMe.ticket })).status !== 403) fail("the lost phone's ticket still works after recovery");
  const freshHistory = (await api("GET", "/me/played", { token: freshMe.ticket })).data.played;
  if (!freshHistory[first] || !freshHistory[importKey]) fail("recovered ticket lost its history");
  await asha.page.goto(url);
  await asha.page.getByText("Ticket no longer valid").waitFor({ timeout: 15000 });
  await shot(asha, "asha-06-revoked");
  await asha.page.getByRole("button", { name: "Remove from this phone" }).click();
  await asha.page.getByRole("button", { name: "Make my ticket" }).waitFor();

  // Move by link to a WebKit phone.
  await fresh.page.getByRole("button", { name: "Move to a phone" }).click();
  const ticketLink = await fresh.page.getByLabel("Ticket link").inputValue();
  await fresh.page.getByRole("img", { name: "Ticket QR code" }).waitFor();
  await shot(fresh, "fresh-02-move");
  if (!ticketLink.includes("#me=" + freshMe.ticket)) fail("move link does not carry the ticket in the fragment");
  await fresh.page.getByRole("button", { name: "Done" }).click();
  const mover = await device("phone", "mover");
  all.push(mover);
  await clearStorage(mover.page);
  await mover.page.goto(ticketLink);
  await mover.page.getByText("A ticket for this phone").waitFor();
  await mover.page.getByText(/Carry Asha's ticket/).waitFor();
  if ((await mover.page.evaluate(() => location.hash)) !== "") fail("ticket left in the address bar");
  await shot(mover, "mover-01-arrive");
  await mover.page.getByRole("button", { name: "Take it" }).click();
  await mover.page.getByLabel("Ticket", { exact: true }).getByText("Asha").waitFor();
  const moverMe = await meOf(mover.page);
  if (moverMe.ticket !== freshMe.ticket) fail("moved ticket differs");
  const moverBlocked = await mover.page.evaluate(() => JSON.parse(localStorage.getItem("tt_blocked") || "[]"));
  if (!moverBlocked.includes("Probe Singer")) fail("blocked artists did not follow the ticket");
  await mover.page.getByText("Probe Singer").waitFor();

  // With the Worker unreachable the ticket holder still plays; plays wait in the outbox.
  await wire(mover, { down: true });
  await mover.page.reload();
  await mover.page.getByText("Your ticket").waitFor();
  await setupShow(mover.page);
  await mover.page.getByRole("button", { name: "Add Asha with their ticket" }).click();
  await mover.page.getByRole("button", { name: /Start the show/ }).click();
  await mover.page.getByRole("button", { name: /^It's with me/ }).waitFor({ timeout: 90000 });
  const offlinePlayed = await play(mover.page, 1);
  const pending = await mover.page.evaluate(() => JSON.parse(localStorage.getItem("tt_me_outbox") || "null"));
  if (!pending || pending.rounds.length < offlinePlayed.length) fail(`offline plays were not queued: ${JSON.stringify(pending)}`);
  await mover.page.getByRole("button", { name: "Game menu" }).click();
  await mover.page.getByRole("button", { name: "Home, keep the game" }).click();
  await mover.page.getByText(/waiting to sync|Offline/).waitFor();
  await shot(mover, "mover-02-offline");
  await wire(mover);
  await mover.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitSynced(mover.page);
  await mover.page.getByText("In sync").waitFor();
  const afterOffline = (await api("GET", "/me/played", { token: freshMe.ticket })).data.played;
  if (offlinePlayed.map(songKey).some(k => !afterOffline[k])) fail("queued offline play never reached the ticket");

  // Delete the ticket for good.
  await mover.page.getByRole("button", { name: "Remove from this phone" }).click();
  await mover.page.getByRole("button", { name: "Delete the ticket for good" }).click();
  await shot(mover, "mover-03-delete");
  await mover.page.getByRole("button", { name: "Delete", exact: true }).click();
  await mover.page.getByRole("button", { name: "Make my ticket" }).waitFor();
  if ((await api("GET", "/me", { token: freshMe.ticket })).status !== 403) fail("deleted ticket still answers");
  if ((await api("GET", "/group/people", { token: invite })).data.people.some(p => p.id === ashaId)) fail("deleted ticket still listed in the group");
  await fresh.page.goto(url);
  await fresh.page.getByText("Ticket no longer valid").waitFor({ timeout: 15000 });

  // The Worker's guards.
  const other = (await api("POST", "/people", { body: { name: "Probe" } })).data;
  const checks = [
    ["missing key", (await api("GET", "/me")).status, 401],
    ["wrong key", (await api("GET", "/me", { token: `${other.person.id}.AAAAAAAAAAAAAAAAAAAAAA` })).status, 403],
    ["malformed key", (await api("GET", "/me", { token: "nope" })).status, 401],
    ["another ticket's prefs", (await api("PATCH", "/me", { token: `${ashaId}.${other.ticket.split(".")[1]}`, body: { prefs: { blocked: [] } } })).status, 403],
    ["forged recovery", (await api("POST", "/people/recover", { body: { challengeId: "AAAAAAAAAAAAAAAAAAAAAA", response: { id: "AAAAAAAAAAAAAAAAAAAAAAAA", response: {} } } })).status, 400],
    ["name too long", (await api("POST", "/people", { body: { name: "x".repeat(25) } })).status, 400],
    ["too many blocked", (await api("PATCH", "/me", { token: other.ticket, body: { prefs: { blocked: Array.from({ length: 51 }, (_, i) => `a${i}`) } } })).status, 400],
    ["too many rounds", (await api("POST", "/me/rounds", { token: other.ticket, body: { rounds: Array.from({ length: 51 }, (_, i) => ({ id: `e${i}00000000`, key: "a" })) } })).status, 400],
    ["bad kind", (await api("POST", "/me/rounds", { token: other.ticket, body: { rounds: [{ id: "e000000000", key: "a", kind: "loud" }] } })).status, 400],
    ["non-member not served", JSON.stringify((await api("GET", `/group/played?people=${other.person.id}`, { token: invite })).data.people), "{}"],
    ["room history without host secret", (await api("POST", `/rooms/${code}/history`, { token: "A".repeat(22), body: {} })).status, 403],
  ];
  // A real challenge with a forged assertion.
  const opts = (await api("POST", "/people/recover/options", { body: {} })).data;
  const forged = await api("POST", "/people/recover", { body: { challengeId: opts.challengeId, response: { id: cred.credentialId.replace(/=+$/, ""), rawId: cred.credentialId, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "AAAA" } } } });
  checks.push(["forged assertion on a real challenge", forged.status >= 400 && forged.status < 500 ? "4xx" : forged.status, "4xx"]);
  const foreign = await fetch(worker.origin + "/api/me", { headers: { origin: "https://evil.example", authorization: `Bearer ${other.ticket}` } });
  checks.push(["foreign origin", foreign.status, 403]);
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push((await api("POST", "/people", { body: { name: `Burst ${i}` } })).status);
  checks.push(["new-ticket rate limit", burst.includes(429) ? "429" : burst.join(","), "429"]);
  const wrong = checks.filter(([, got, want]) => got !== want);
  if (wrong.length) fail("guards: " + wrong.map(([n, got, want]) => `${n} got ${got} want ${want}`).join("; "));
  const leaked = urlsSeen.filter(u => TICKET_RX.test(u));
  if (leaked.length) fail(`a secret travelled in a URL: ${leaked[0]}`);

  const errors = all.flatMap(d => d.errors);
  if (errors.length) fail("page errors: " + errors.join(" | "));
  console.log("PASS tickets", `worker=${A.worker ? worker.origin : "local wrangler dev"}`,
    `ravi=${raviKeys.length} songs recorded for Asha, maker crate ${makerQueue.length} tracks with 0 repeats, room ${code} crate ${show.queue.length} tracks with 0 repeats, ${checks.length} guards, ${urlsSeen.length} URLs checked`);
} catch (e){
  exit = 1;
  console.log("FAIL tickets", e.message.split("\n").slice(0, 8).join(" / "));
  if (shotsDir) for (const d of all) await d.page.screenshot({ path: path.join(shotsDir, `fail-${d.label}.png`) }).catch(() => {});
} finally {
  for (const d of all) await d.browser.close().catch(() => {});
  server.close();
  worker.stop();
  process.exit(exit);
}
