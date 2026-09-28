import fs from "node:fs";
import { serve, open, saved } from "./harness.mjs";
import { ladderFor } from "../src/lib/config.ts";
import { SNIP_ACCEPTED, SNIP_INDEX_V, SNIP_LEGACY, SNIP_WINDOW_SEC } from "../src/lib/constants.js";

// The index the build serves: the committed one, or the v5 fixture copied in
// to check the switch (docs/testing-and-deploy.md).
const index = JSON.parse(fs.readFileSync(new URL("../dist/snips.json", import.meta.url)));
const accept = SNIP_ACCEPTED[index.v];
if (!accept || Object.values(index.snips).some(e => e.method !== accept.method || !accept.clean(e) || e.endSec - e.startSec !== SNIP_WINDOW_SEC))
  throw new Error(`dist/snips.json is not an accepted index of ${SNIP_WINDOW_SEC}s windows`);
console.log(`index v${index.v} (${accept.method}), ${Object.keys(index.snips).length} windows`);
const other = index.v === SNIP_INDEX_V ? SNIP_LEGACY.v : SNIP_INDEX_V;
const server = await serve();
const fail = message => { throw new Error(message); };

async function setup(page, difficulty){
  await page.goto(server.url + "seed.html");
  await page.evaluate(() => localStorage.clear());
  await page.goto(server.url);
  await page.getByRole("radio", { name:difficulty, exact:false }).click();
  await page.getByRole("radio", { name:"3", exact:true }).click();
  await page.getByRole("button", { name:/Start (the|a new) show/ }).click();
}

async function ladder(page, difficulty){
  await page.getByRole("button", { name:/It's with me/ }).click();
  await page.getByText("Ears on").waitFor();
  await page.getByRole("button", { name:"I know this one" }).waitFor({ timeout:30000 });
  await page.waitForFunction(() => window.__ttLastMode, null, { timeout:30000 });
  const mode = await page.evaluate(() => window.__ttLastMode);
  if (mode !== (difficulty === "Easy" ? "plain" : "snip")) fail(`${difficulty}: played ${mode}`);
  const L = ladderFor(difficulty === "Easy");
  for (const sec of L.segments.slice(1)){
    await page.getByText("Guess, or hear more").waitFor({ timeout:30000 });
    await page.getByRole("button", { name:`Hear ${sec}s more` }).click();
  }
  await page.getByText("Guess, or hear more").waitFor({ timeout:30000 });
  const state = await saved(page);
  const track = state.game.queue[state.game.trackIdx];
  const end = await page.evaluate(() => window.__testedAudio?.currentTime);
  if (difficulty !== "Easy" && (!track.snip || end > track.snip.endSec + 0.1))
    fail(`music clip escaped interval: ${end} > ${track.snip?.endSec}`);
  await page.getByRole("button", { name:"Replay" }).click();
  await page.getByText("Guess, or hear more").waitFor({ timeout:30000 });
  const replayEnd = await page.evaluate(() => window.__testedAudio?.currentTime);
  if (difficulty !== "Easy" && replayEnd > track.snip.endSec + 0.1)
    fail(`replay escaped interval: ${replayEnd} > ${track.snip.endSec}`);
  const lastRung = `+${L.segments[L.last]}s · ${L.points[L.last]}`;
  if (!(await page.getByText(lastRung).count())) fail(`missing ${lastRung} final rung`);
  if (await page.getByText(/^\+\d+s · \d+$/).count() !== L.last) fail(`${difficulty}: strip does not show ${L.segments.length} rungs`);
  if (await page.getByRole("button", { name:/^Hear \d+s more/ }).count()) fail(`${difficulty}: offers a rung past its ladder`);
}

/* Earlier releases saved their snips inside the queue: MusiCNN's 12s and 20s
   windows, and 10s ones with 100/70/50/30 scores before that. Such a save
   must resume on the current index, rebound to its SNIP_WINDOW_SEC windows,
   with its score and history untouched. */
async function resumeOldSave(page, oldSecs){
  const st = await saved(page);
  const me = st.game.cast[0];
  st.game.queue = st.game.queue.map(t => {
    if (!t.snip) return t;
    const { method, ...old } = t.snip, startSec = old.startSec + 3;
    return { ...t, snip:{ ...old, startSec, endSec:startSec + oldSecs } };
  });
  st.game.cast = st.game.cast.map(c => ({ ...c, score:c.id === me.id ? 70 : 0 }));
  st.game.history = [{ id:me.id, song:"Old release song", points:70, round:1 }];
  st.game.turn = 1 % st.game.cast.length;
  st.screen = "setup";
  await page.goto(server.url + "seed.html");
  await page.evaluate(v => localStorage.setItem("tuneteasers_v7", JSON.stringify(v)), st);
  await page.goto(server.url);
  await page.getByRole("button", { name:"Resume" }).click();
  await page.getByRole("button", { name:/It's with me/ }).click();
  await page.getByText("Guess, or hear more").waitFor({ timeout:45000 });
  if (await page.evaluate(() => window.__ttLastMode) !== "snip") fail("old save did not play a verified snip");
  const now = await saved(page);
  const t = now.game.queue[now.game.trackIdx];
  const e = index.snips[t.sourceId];
  if (!t.snip || !e || t.snip.startSec !== e.startSec || t.snip.endSec !== e.endSec || t.snip.method !== SNIP_METHOD)
    fail(`old save resumed on ${JSON.stringify(t.snip)}, not the current window ${JSON.stringify(e)}`);
  if (now.game.cast.find(c => c.id === me.id).score !== 70 || now.game.history.length !== 1) fail("old save lost its score or history");
}

async function run(profile){
  const { browser, page, errors } = await open(profile, { reducedMotion:true });
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args){
      window.__testedAudio = this;
      window.__playCalls = (window.__playCalls || 0) + 1;
      return play.apply(this, args);
    };
  });
  try {
    for (const difficulty of ["Easy", "Medium", "Hard"]){
      await setup(page, difficulty);
      await ladder(page, difficulty);
      console.log(`PASS ${profile} ${difficulty} max rung and replay`);
    }
    for (const secs of [SNIP_WINDOW_SEC, 20, 10]){
      await resumeOldSave(page, secs);
      console.log(`PASS ${profile} a save from the ${secs}s-window release resumes on the current windows with its score`);
    }
    await page.getByRole("button", { name:"Game menu" }).click();
    await page.getByRole("button", { name:"Home, keep the game" }).click();
    await page.route("**/snips.json", route => route.fulfill({ status:404, body:"" }));
    const beforeResume = await page.evaluate(() => window.__playCalls || 0);
    await page.getByRole("button", { name:"Resume" }).click();
    await page.getByRole("alert").getByText(/Not enough verified music-only clips remain/).waitFor();
    if (await page.evaluate(() => window.__playCalls || 0) !== beforeResume) fail("resume played without current index");
    await page.unroute("**/snips.json");
    console.log(`PASS ${profile} stale saved game cannot resume without index`);
    for (const variant of ["missing", "mismatched", "legacy", "v2", "v3", "crossed", "unknown", "short", "long", "stale"]){
      await page.route("**/snips.json", route => {
        if (variant === "missing") return route.fulfill({ status:404, body:"" });
        const resize = (secs, extra = {}) => Object.fromEntries(Object.entries(index.snips).map(([id,e]) => [id,{ ...e, endSec:e.startSec + secs, ...extra }]));
        const bad = variant === "legacy" ? { v:1, snips:{} }
          : variant === "v2" ? { ...index, v:2, snips:resize(10, { method:"continuous-v2" }) }
          : variant === "v3" ? { ...index, v:3, snips:resize(20, { method:"continuous-v3" }) }
          : variant === "crossed" ? { ...index, v:other }
          : variant === "unknown" ? { ...index, v:99 }
          : variant === "short" ? { ...index, snips:resize(SNIP_WINDOW_SEC - 2) }
          : variant === "long" ? { ...index, snips:resize(20) }
          : variant === "stale" ? { ...index, built:"2020-01-01T00:00:00.000Z" }
          : { ...index, snips:Object.fromEntries(Object.entries(index.snips).map(([id,e]) => [id,{ ...e, sourceId:"another-recording" }])) };
        return route.fulfill({ contentType:"application/json", body:JSON.stringify(bad) });
      });
      await setup(page, "Medium");
      await page.getByRole("alert").getByText(/Not enough verified music-only clips/).waitFor({ timeout:30000 });
      if (await page.getByRole("button", { name:/It's with me/ }).count()) fail(`${variant}: started an unsafe game`);
      await page.unroute("**/snips.json");
      console.log(`PASS ${profile} ${variant} index shortage`);
    }
    if (errors.length) fail(`${profile} page errors: ${errors.join(" | ")}`);
  } finally { await browser.close(); }
}

let exit = 0;
try { for (const profile of ["phone", "desktop"]) await run(profile); }
catch(e){ exit = 1; console.error("FAIL", e); }
finally { server.close(); }
process.exit(exit);
