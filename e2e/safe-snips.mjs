import fs from "node:fs";
import { serve, open, saved } from "./harness.mjs";

const index = JSON.parse(fs.readFileSync(new URL("../public/snips.json", import.meta.url)));
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
  for (const sec of [7, 8]){
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
  if (!(await page.getByText("+8s · 30").count())) fail("missing +8s final rung");
}

/* The previous release saved 10s snips inside the queue and scored rungs
   100/70/50/30. Such a save must resume on the current index (rebound to 20s
   windows) with its score and history untouched. */
async function resumeOldSave(page){
  const st = await saved(page);
  const me = st.game.cast[0];
  st.game.queue = st.game.queue.map(t => (t.snip ? { ...t, snip:{ ...t.snip, endSec:t.snip.startSec + 10 } } : t));
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
  if (!t.snip || t.snip.endSec - t.snip.startSec !== 20) fail(`old save resumed on a ${t.snip ? t.snip.endSec - t.snip.startSec : "missing"}s window`);
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
    await resumeOldSave(page);
    console.log(`PASS ${profile} a save from the 10s-window release resumes on 20s windows with its score`);
    await page.getByRole("button", { name:"Game menu" }).click();
    await page.getByRole("button", { name:"Home, keep the game" }).click();
    await page.route("**/snips.json", route => route.fulfill({ status:404, body:"" }));
    const beforeResume = await page.evaluate(() => window.__playCalls || 0);
    await page.getByRole("button", { name:"Resume" }).click();
    await page.getByRole("alert").getByText(/Not enough verified music-only clips remain/).waitFor();
    if (await page.evaluate(() => window.__playCalls || 0) !== beforeResume) fail("resume played without current index");
    await page.unroute("**/snips.json");
    console.log(`PASS ${profile} stale saved game cannot resume without index`);
    for (const variant of ["missing", "mismatched", "legacy", "v2", "short", "stale"]){
      await page.route("**/snips.json", route => {
        if (variant === "missing") return route.fulfill({ status:404, body:"" });
        const shorten = e => ({ ...e, endSec:e.startSec + 10 });
        const bad = variant === "legacy" ? { v:1, snips:{} }
          : variant === "v2" ? { ...index, v:2, snips:Object.fromEntries(Object.entries(index.snips).map(([id,e]) => [id,{ ...shorten(e), method:"continuous-v2" }])) }
          : variant === "short" ? { ...index, snips:Object.fromEntries(Object.entries(index.snips).map(([id,e]) => [id,shorten(e)])) }
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
