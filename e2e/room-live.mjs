/* A buzz-in room on the live site, played the way a party plays it: no
   socket proxy and no local Worker, so every check reads what the screens
   show. Desktop Chromium is the host screen and two WebKit iPhones (separate
   contexts) join by the code it shows. Song 1: a buzz and a right answer.
   Song 2: a phone reloads and keeps its seat, then buzzes first and is wrong,
   and the phone in line behind it is right. The host's points follow each
   answer, the host ends the show from its menu, and both phones show the
   final screen.
   Production gets only what a party sends: one room, two seats, no floods or
   limit probes, no phone group, no email.
   E2E_URL=https://sathwik-katepally.github.io/tuneteasers/ node e2e/room-live.mjs
   (without E2E_URL it serves dist/, which still uses the deployed Worker) */
import { chromium, webkit, devices } from "playwright";
import { serve, silence, skipLanding, MUTE_ARGS } from "./harness.mjs";
import { displayTitle, songKey } from "../src/lib/utils.js";

const fail = msg => { throw new Error(msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = await serve();
const url = server.url;

const hostBrowser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] });
const phoneBrowser = await webkit.launch();
async function device(browser, options, label){
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  await context.addInitScript(silence);
  await context.addInitScript(skipLanding);
  const page = await context.newPage();
  const errors = [], logs = [];
  page.on("console", m => { if (m.text().startsWith("[tt]")) logs.push(m.text()); });
  page.on("pageerror", e => errors.push(`${label}: ${e.message}`));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  return { label, page, errors, logs };
}

const host = await device(hostBrowser, { viewport: { width: 1440, height: 900 } }, "host");
const asha = await device(phoneBrowser, devices["iPhone 13"], "Asha");
const ravi = await device(phoneBrowser, devices["iPhone 13"], "Ravi");
const phones = [asha, ravi], all = [host, ...phones];

const hostShow = () => host.page.evaluate(() => JSON.parse(localStorage.getItem("tt_room_host") || "null"));
async function currentTitle(){
  const s = await hostShow();
  return displayTitle(s.queue[s.idx].title);
}
// A wrong guess comes from the site's public list and is never a song in this show.
const corpus = await (await fetch(url + "corpus.json")).json();
const publicTitles = corpus.songs.map(r => displayTitle(r[corpus.cols.indexOf("title")]));
async function wrongTitle(){
  const s = await hostShow();
  const inShow = new Set(s.queue.map(t => songKey(t.title)));
  return publicTitles.find(t => !inShow.has(songKey(t)) && t.length > 6);
}

const buzzBtn = p => p.page.locator('button[aria-label="Buzz"]');
const myTurn = p => p.page.getByRole("button", { name: "Lock it in" });
// A tap that lands just as buzzing closes is rightly ignored, so a buzz
// counts once the phone shows what follows it.
async function buzz(p, next){
  const t0 = Date.now();
  while (!(await next.isVisible())){
    if (Date.now() - t0 > 20000) fail(`${p.label}'s buzz never reached the room`);
    await buzzBtn(p).click({ timeout: 2000 }).catch(() => {});
    await next.waitFor({ timeout: 3000 }).catch(() => {});
  }
}

// A stream that won't start is skipped the way a host would; the song number stays.
let deadStreams = 0;
async function live(p, n){
  const t0 = Date.now();
  const dead = host.page.getByText(/won't stream right now|isn't available/);
  for (;;){
    if (await p.page.getByText(new RegExp(`^Song ${n} of \\d+`)).isVisible() && await buzzBtn(p).isVisible()) return;
    if (await dead.isVisible()){
      if (++deadStreams > 2) fail("three dead streams");
      await host.page.getByRole("button", { name: "Skip this song" }).click({ timeout: 1500 }).catch(() => {});
    }
    if (Date.now() - t0 > 90000) fail(`song ${n} never opened the buzzer on ${p.label}'s phone`);
    await sleep(250);
  }
}

// A suggestion is named by its title, then its films and year ("Chaleya, Jawan, 2023").
const optionName = text => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(,|$)`);
async function answer(p, text){
  const input = p.page.getByLabel("Your answer");
  await myTurn(p).waitFor({ timeout: 10000 });
  await input.fill(text.slice(0, Math.max(4, Math.ceil(text.length * 0.6))));
  const option = p.page.getByRole("option", { name: optionName(text) });
  if (await option.count()) await option.first().click();
  else { await input.fill(text); await myTurn(p).click(); }
}

/* The answering phone names the song: the big screen's reveal must credit
   the points its pad promised, on top of what the player already had. */
async function scores(p, before){
  const worth = Number((await p.page.getByText(/^Worth \d+ if you're right/).textContent()).match(/\d+/)[0]);
  await answer(p, await currentTitle());
  await host.page.getByText(`+${worth} for ${p.label}, ${before + worth} in total`).waitFor({ timeout: 20000 });
  await p.page.getByText("You got it").waitFor();
  return before + worth;
}

const seats = () => host.page.getByLabel("Players", { exact: true }).evaluate(el => [...el.children].map(c => c.textContent));

let exit = 0;
try {
  await host.page.goto(url);
  await host.page.getByRole("radio", { name: "Buzz in" }).click();
  await host.page.getByRole("button", { name: "Open a room" }).click();
  await host.page.getByText("Doors open").waitFor({ timeout: 20000 });
  const code = (await host.page.locator("[aria-label^='Room code ']").first().getAttribute("aria-label")).replace(/Room code |\s/g, "");
  if (!/^[A-Z]{4}$/.test(code)) fail(`bad room code ${code}`);

  for (const p of phones){
    await p.page.goto(url);
    await p.page.getByRole("button", { name: "Got a code? Join a show" }).click();
    await p.page.getByLabel("Room code").fill(code);
    await p.page.getByLabel("Your name").fill(p.label);
    await p.page.getByRole("button", { name: "Join the show" }).click();
    await p.page.getByText("You're in").waitFor({ timeout: 15000 });
  }
  await host.page.getByText("2 in", { exact: true }).waitFor({ timeout: 10000 });
  await host.page.getByRole("button", { name: "Start the show" }).click();

  // Song 1: Asha buzzes and names it.
  await live(asha, 1);
  await live(ravi, 1);
  await buzz(asha, myTurn(asha));
  let ashaScore = await scores(asha, 0);
  await ravi.page.getByText("Asha got it").waitFor();
  await asha.page.getByText(new RegExp(`^Song \\d+ of \\d+ · ${ashaScore}$`)).waitFor();

  // Song 2: Ravi's phone reloads mid-song and gets its seat back.
  await live(ravi, 2);
  await ravi.page.reload();
  await live(ravi, 2);
  await ravi.page.getByText("Ravi", { exact: true }).waitFor();
  await ravi.page.getByText(/^Song 2 of \d+ · 0$/).waitFor();
  const seated = (await seats()).join();
  if (seated !== `Asha${ashaScore},Ravi0`) fail(`host seats after the reload: ${seated}`);

  // Ravi buzzes first and is wrong; Asha, in line behind him, names it.
  await live(asha, 2);
  await buzz(ravi, myTurn(ravi));
  await buzz(asha, asha.page.getByText(/^In line\./));
  await answer(ravi, await wrongTitle());
  await ravi.page.getByText("Not it. You're out for this song.").waitFor();
  await host.page.getByText(/^Ravi said “/).first().waitFor({ timeout: 5000 });
  ashaScore = await scores(asha, ashaScore);
  await ravi.page.getByText("Asha got it").waitFor();

  // The host ends the show from its menu; both phones go to the final screen.
  await host.page.getByRole("button", { name: "Game menu" }).click();
  await host.page.getByRole("button", { name: "End game" }).click();
  await host.page.getByRole("button", { name: "End it" }).click();
  for (const [p, place, points] of [[asha, "You take it", ashaScore], [ravi, "2nd place", 0]]){
    await p.page.getByText("That's the show").waitFor({ timeout: 15000 });
    await p.page.getByText(place, { exact: true }).waitFor();
    await p.page.getByText(`${points} points`, { exact: true }).waitFor();
  }

  const errors = all.flatMap(d => d.errors);
  if (errors.length) fail("page errors:\n" + errors.join("\n"));
  console.log(`room-live: PASS (room ${code} at ${url}, Asha ${ashaScore}, Ravi 0, deadStreams=${deadStreams})`);
} catch (e){
  console.error("room-live: FAIL", e.message);
  for (const d of all) console.error(`--- ${d.label} screen\n` + (await d.page.locator("body").innerText().catch(() => "")).slice(0, 500));
  for (const d of all) console.error(`--- ${d.label} app log\n` + d.logs.slice(-15).join("\n"));
  for (const d of all) if (d.errors.length) console.error(`--- ${d.label} page errors\n` + d.errors.join("\n"));
  exit = 1;
} finally {
  await hostBrowser.close().catch(() => {});
  await phoneBrowser.close().catch(() => {});
  server.close();
}
// The suite lock keeps the event loop alive, as in the other suites.
process.exit(exit);
