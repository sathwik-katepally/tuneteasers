/* UX audit: walk the real first-run journeys and count what a person has to
   tap, decide and read before the first song. Silent browsers (harness).
   node audit/journeys.mjs --site=<url> --out=<dir> [--journey=pass|room|return|group] [--label=live] */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { args, silence, MUTE_ARGS } from "../e2e/harness.mjs";

const A = args({ site: "https://sathwik-katepally.github.io/tuneteasers/", out: "audit/shots", journey: "pass,room,return,group", label: "live" });
const OUT = path.resolve(A.out);
fs.mkdirSync(OUT, { recursive: true });
const journeys = A.journey.split(",");
const report = [];
const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";

async function device(kind){
  const phone = kind === "phone";
  const browser = phone ? await webkit.launch() : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] });
  const context = await browser.newContext(phone ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } });
  await context.addInitScript(silence);
  if (A.worker) await context.route(u => u.host === WORKER_HOST, async route => {
    const u = new URL(route.request().url());
    try { return route.fulfill({ response: await route.fetch({ url: A.worker + u.pathname + u.search }) }); } catch { return route.abort(); }
  });
  if (A.worker) await context.routeWebSocket(u => u.host === WORKER_HOST, ws => {
    const u = new URL(ws.url());
    const up = new WebSocket(A.worker.replace(/^http/, "ws") + u.pathname + u.search, { headers: { origin: new URL(A.site).origin } });
    const pending = [];
    up.onopen = () => { for (const m of pending.splice(0)) up.send(m); };
    up.onmessage = e => ws.send(String(e.data));
    up.onclose = e => { try { ws.close({ code: e.code >= 4000 ? e.code : 1000, reason: e.reason }); } catch {} };
    ws.onMessage(m => { if (up.readyState === 1) up.send(String(m)); else pending.push(String(m)); });
    ws.onClose(() => { try { up.close(); } catch {} });
  });
  const page = await context.newPage();
  return { browser, context, page };
}

/* One journey's tally: taps, keystroke fields, and each screen's words,
   controls and scroll height. */
function tally(name, profile){
  const t = { journey: name, profile, taps: 0, typed: 0, screens: [] };
  report.push(t);
  return {
    t,
    async tap(loc){ await loc.click(); t.taps++; },
    async type(loc, text){ await loc.fill(text); t.typed++; },
    async shot(page, screen, { settle = 900, full = true } = {}){
      await page.waitForTimeout(settle);
      const m = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
        const ctl = [...document.querySelectorAll("button, input, a[href], select, textarea")].filter(e => vis(e) && !e.disabled && !e.closest("[aria-hidden=true]"));
        const groups = new Set(ctl.map(e => e.closest("[role=radiogroup]") || e));
        const words = (document.body.innerText.match(/[\p{L}\p{N}'’]+/gu) || []).length;
        return { controls: ctl.length, choices: groups.size, words, scroll: +(document.documentElement.scrollHeight / innerHeight).toFixed(2) };
      });
      const file = `${A.label}-${name}-${profile}-${String(t.screens.length + 1).padStart(2, "0")}-${screen}.png`;
      await page.screenshot({ path: path.join(OUT, file), fullPage: full });
      t.screens.push({ screen, ...m, file });
    },
  };
}

const btn = (page, name) => page.getByRole("button", { name });

async function firstSong(page, T){
  await T.tap(btn(page, /^It's with me|roll it$/));
  await page.getByText("Ears on").waitFor();
  await T.shot(page, "countdown", { settle: 300, full: false });
  await page.waitForFunction(() => window.__ttClips?.length || document.body.innerText.includes("Now playing") || document.body.innerText.includes("Tap to play"), null, { timeout: 40000 });
  await T.shot(page, "first-song", { settle: 1200 });
}

async function passJourney(profile){
  const { browser, page } = await device(profile);
  const T = tally("pass", profile);
  const t0 = Date.now();
  await page.goto(A.site);
  await T.shot(page, "landing");
  await T.tap(btn(page, "Set up a game"));
  await btn(page, /Start the show/).waitFor();
  await T.shot(page, "setup");
  await T.tap(btn(page, /Start the show/));
  await btn(page, /^It's with me|roll it$/).waitFor({ timeout: 40000 });
  await T.shot(page, "handover");
  await firstSong(page, T);
  T.t.secondsToFirstSong = Math.round((Date.now() - t0) / 1000);
  // A returning visit: reload lands where?
  await page.reload();
  await page.waitForTimeout(1500);
  await T.shot(page, "reload-mid-game");
  await browser.close();
}

/* Returning player: second visit after a finished show; realistic tweaks (names). */
async function returnJourney(profile){
  const { browser, page } = await device(profile);
  const T = tally("return", profile);
  await page.goto(A.site);
  await btn(page, "Set up a game").click();
  await page.waitForTimeout(800);
  await page.goto("about:blank");
  await page.goto(A.site);
  await btn(page, /Start the show/).waitFor();
  await T.shot(page, "home-returning");
  // Realistic first real setup: name three people.
  const renames = ["Asha", "Ravi"];
  for (const [i, n] of renames.entries()){
    await T.tap(btn(page, `Rename Player ${i + 1}`));
    await page.keyboard.type(n); T.t.typed++;
    await page.keyboard.press("Enter");
  }
  await T.tap(btn(page, "Add"));
  await page.keyboard.type("Meena"); T.t.typed++;
  await page.keyboard.press("Enter");
  await T.shot(page, "home-named");
  await browser.close();
}

async function roomJourney(profile){
  const host = await device(profile);
  const T = tally("room-host", profile);
  const hp = host.page;
  await hp.goto(A.site);
  await T.tap(btn(hp, "Set up a game"));
  await T.tap(hp.getByRole("radio", { name: "Buzz in" }));
  await T.shot(hp, "setup-buzz");
  await T.tap(btn(hp, "Open a room"));
  const code = await hp.locator("[aria-label^='Room code ']").getAttribute("aria-label").then(s => s.replace(/Room code | /g, ""));
  await hp.getByText("Doors open").waitFor({ timeout: 20000 });
  await T.shot(hp, "lobby-empty");
  const phones = [];
  const names = ["Asha", "Ravi", "Meena"];
  for (const [i, n] of names.entries()){
    const d = await device("phone");
    const P = tally(`room-phone-${i === 0 ? "link" : i === 1 ? "code" : "link2"}`, "phone");
    if (i === 1){
      // Typed code: open the site like a fresh visitor, find the join.
      await d.page.goto(A.site);
      await P.shot(d.page, "landing");
      await P.tap(btn(d.page, "Join with a code"));
      await P.type(d.page.getByLabel("Room code"), code);
    } else {
      await d.page.goto(`${A.site}#room=${code}`);
    }
    await d.page.getByLabel("Your name").waitFor();
    await P.shot(d.page, "join-form");
    await P.type(d.page.getByLabel("Your name"), n);
    await P.tap(btn(d.page, "Join the show"));
    await d.page.waitForTimeout(1500);
    await P.shot(d.page, "seated");
    phones.push({ ...d, P });
  }
  await T.shot(hp, "lobby-3");
  await T.tap(btn(hp, "Start the show"));
  await hp.waitForTimeout(1500);
  await T.shot(hp, "host-countdown", { settle: 200, full: false });
  await hp.waitForFunction(() => /Buzz on your phone|Now playing|Hear/.test(document.body.innerText), null, { timeout: 45000 }).catch(() => {});
  await T.shot(hp, "host-song", { settle: 1500 });
  for (const ph of phones) await ph.P.shot(ph.page, "buzzer-live", { settle: 200 });
  await Promise.all([host.browser.close(), ...phones.map(p => p.browser.close())]);
}

async function groupJourney(){
  const a = await device("phone");
  const T = tally("group", "phone");
  await a.page.goto(A.site);
  await btn(a.page, "Set up a game").click();
  await btn(a.page, "Make a group").scrollIntoViewIfNeeded();
  await T.shot(a.page, "group-card", { full: false });
  await T.tap(btn(a.page, "Make a group"));
  await T.shot(a.page, "group-create", { full: false });
  const nameBox = a.page.getByRole("textbox").first();
  await T.type(nameBox, "Audit fam");
  await T.tap(a.page.getByRole("button", { name: /Make it|Make the group|Create/ }));
  await a.page.waitForTimeout(2500);
  await T.shot(a.page, "group-invite", { full: false });
  await a.browser.close();
}

/* tt-skip: "Heard it too much" on the listening screen, then the countdown that names the skipped song. */
async function skipJourney(profile){
  const { browser, page } = await device(profile);
  const T = tally("skip", profile);
  await page.goto(A.site);
  await btn(page, "Set up a game").click();
  await btn(page, /Start the show/).click();
  await btn(page, /^It's with me|roll it$/).waitFor({ timeout: 40000 });
  await firstSong(page, T);
  await T.tap(btn(page, /^Heard it/));
  await page.waitForTimeout(700);
  await T.shot(page, "after-heard-it", { settle: 200, full: false });
  await browser.close();
}

/* tt-skip room: a phone's vote link while a clip plays. */
async function skipRoomJourney(){
  const host = await device("desktop");
  const hp = host.page;
  const T = tally("skip-room", "desktop");
  await hp.goto(A.site);
  await btn(hp, "Set up a game").click();
  await hp.getByRole("radio", { name: "Buzz in" }).click();
  await btn(hp, "Open a room").click();
  const code = await hp.locator("[aria-label^='Room code ']").getAttribute("aria-label").then(s => s.replace(/Room code | /g, ""));
  await hp.getByText("Doors open").waitFor({ timeout: 20000 });
  const d = await device("phone");
  const P = tally("skip-room-phone", "phone");
  await d.page.goto(`${A.site}#room=${code}`);
  await d.page.getByLabel("Your name").fill("Asha");
  await btn(d.page, "Join the show").click();
  await d.page.waitForTimeout(1200);
  await btn(hp, "Start the show").click();
  await d.page.getByRole("button", { name: /Heard it too much/ }).waitFor({ timeout: 45000 }).catch(() => {});
  await P.shot(d.page, "buzzer-with-vote", { settle: 400 });
  await T.shot(hp, "host-with-skip", { settle: 100 });
  await Promise.all([host.browser.close(), d.browser.close()]);
}

/* tt-tickets: the home screen with the ticket card, making a ticket with a
   passkey (Chromium virtual authenticator), and a phone joining a room with it. */
async function ticketJourney(){
  const { browser, context, page } = await device("desktop");
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const T = tally("ticket", "desktop");
  await page.goto(A.site);
  await btn(page, "Set up a game").click();
  await btn(page, /Start the show/).waitFor();
  await T.shot(page, "home-with-ticket-card");
  await T.tap(btn(page, "Make my ticket"));
  await T.shot(page, "make-ticket", { full: false });
  await T.type(page.getByLabel("Your name"), "Asha");
  await T.tap(btn(page, "Print it"));
  await page.getByText(/In sync|Passkey saved|Syncing/).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await T.shot(page, "ticket-made");
  await browser.close();

  const ph = await device("phone");
  const P = tally("ticket-phone", "phone");
  await ph.page.goto(A.site);
  await btn(ph.page, "Set up a game").click();
  await btn(ph.page, /Start the show/).waitFor();
  await P.shot(ph.page, "home-with-ticket-card");
  await ph.browser.close();
}

for (const j of journeys){
  try {
    if (j === "pass") for (const p of ["phone", "desktop"]) await passJourney(p);
    if (j === "return") await returnJourney("phone");
    if (j === "room") await roomJourney("desktop");
    if (j === "group") await groupJourney();
    if (j === "skip") for (const p of ["phone", "desktop"]) await skipJourney(p);
    if (j === "skip-room") await skipRoomJourney();
    if (j === "ticket") await ticketJourney();
  } catch (e){ console.error(`journey ${j} failed:`, e.message); report.push({ journey: j, error: e.message }); }
}
fs.writeFileSync(path.join(OUT, `${A.label}-report.json`), JSON.stringify(report, null, 2));
for (const r of report){
  if (r.error){ console.log(`${r.journey}: ERROR ${r.error}`); continue; }
  console.log(`\n${r.journey} (${r.profile}) taps=${r.taps} typed=${r.typed}${r.secondsToFirstSong ? ` secs=${r.secondsToFirstSong}` : ""}`);
  for (const s of r.screens) console.log(`  ${s.screen.padEnd(16)} words=${String(s.words).padStart(4)} controls=${String(s.controls).padStart(3)} choices=${String(s.choices).padStart(3)} scroll=${s.scroll}`);
}
