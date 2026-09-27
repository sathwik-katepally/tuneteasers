/* Plays one full show through the real UI against the real song sources and
   checks the scoring bookkeeping at the end.
   node e2e/game.mjs --profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both
     --difficulty=easy|medium|hard --rounds=3 [--categories=item,mass] [--reduced] [--no-worker] [--shots=dir] [--url=http://...]
   --no-worker makes the project's Worker unreachable (songs then come from the mirror).
   --categories picks those song categories (corpus tags) and checks every queued song carries one. */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved } from "./harness.mjs";
import { songKey } from "../src/lib/utils.js";
import { CATEGORIES } from "../src/lib/config.ts";

const A = args({ profile: "phone", mode: "players", mix: "both", difficulty: "medium", rounds: "3" });
const shotsDir = A.shots && A.shots !== "true" ? A.shots : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

const server = A.url ? null : await serve();
const url = A.url || server.url;
const { browser, page, errors } = await open(A.profile, { reducedMotion: A.reduced === "true" });
const taken = new Set();
const overflow = [];
async function shot(name, settle = 400){
  if (taken.has(name)) return;
  taken.add(name);
  await page.waitForTimeout(settle);
  const spill = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  if (spill > 1 && name !== "01-setup") overflow.push(`${name}+${spill}px`);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${A.profile}-${name}.png`) });
}
const btn = name => page.getByRole("button", { name });
const fail = msg => { throw new Error(msg); };

let exit = 0;
try {
  if (A["no-worker"] === "true") await page.route(u => u.host === "tuneteasers-saavn.sathwik-katepally.workers.dev", r => r.abort("connectionrefused"));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await page.getByRole("radio", { name: A.mode === "teams" ? "Teams" : "Solo" }).click();
  await page.getByRole("radio", { name: { bolly: "Hindi", telugu: "Telugu", both: "Both" }[A.mix], exact: true }).click();
  await page.getByRole("radio", { name: A.difficulty, exact: false }).click();
  await page.getByRole("radio", { name: A.rounds, exact: true }).click();
  const categories = A.categories ? A.categories.split(",") : [];
  for (const id of categories){
    const label = CATEGORIES.find(c => c.id === id)?.label ?? fail(`unknown category ${id}`);
    const chip = page.getByRole("button", { name: new RegExp(`^${label}, \\d+ songs$`) });
    await chip.click();
    if (await chip.getAttribute("aria-pressed") !== "true") fail(`${label} did not select`);
  }
  if (A.mode === "teams"){
    const add = btn("Member").first();
    await add.click(); await page.keyboard.type("Priya"); await page.keyboard.press("Enter");
    await btn("Member").first().click(); await page.keyboard.type("Rahul"); await page.keyboard.press("Enter");
  } else {
    await btn("Add").click(); await page.keyboard.type("Anu"); await page.keyboard.press("Enter");
  }
  await shot("01-setup");
  await btn(/Start the show/).click();
  await shot("02-loading", 450);

  let turns = 0, extended = false, hinted = false, resumed = false, deadStreams = 0;
  const expectMode = A.difficulty === "easy" ? ["plain"] : ["snip", "muffle", "plain"];
  for (let guard = 0; guard < 80; guard++){
    const handover = page.getByRole("button", { name: /^It's with me|roll it$/ });
    const board = page.getByRole("button", { name: /On to round|Roll the credits/ });
    const podium = btn("Same crowd again");
    await Promise.race([handover.waitFor(), board.waitFor(), podium.waitFor()].map(p => p.catch(() => {})));
    if (await podium.isVisible()) break;
    if (await board.isVisible()){
      await page.waitForTimeout(1400);
      await shot("09-scoreboard");
      await board.click();
      await board.waitFor({ state: "detached" });
      continue;
    }
    await shot("03-handover", 1500);
    await page.evaluate(() => { window.__ttLastMode = null; });
    await handover.click();
    await page.getByText("Ears on").waitFor();
    await shot("04-countdown", 900);
    const know = btn("I know this one");
    await know.waitFor();
    // A dead stream is real life on Saavn: the game says so and offers Skip.
    for (let tries = 0; ; tries++){
      const dead = page.getByText("This song won't stream right now");
      await Promise.race([
        page.waitForFunction(() => window.__ttLastMode, null, { timeout: 30000 }),
        dead.waitFor({ timeout: 30000 }),
      ]);
      if (!(await dead.isVisible())) break;
      if (tries === 2) fail("three dead streams in a row");
      deadStreams++;
      await page.evaluate(() => { window.__ttLastMode = null; });
      await btn("Skip this song").click();
    }
    const mode = await page.evaluate(() => window.__ttLastMode);
    if (!expectMode.includes(mode)) fail(`turn ${turns}: mode ${mode} not in ${expectMode}`);
    await shot("05-playing", 1200);
    if (!extended){
      await page.getByText("Guess, or hear more").waitFor({ timeout: 20000 });
      await shot("05b-listened", 200);
      await btn(/Hear 5s/).click();
      await page.getByText(/s left/).waitFor({ timeout: 20000 });
      extended = true;
    }
    if (!hinted && turns === 1){
      await btn(/Hint, costs/).click();
      await shot("05c-hint", 300);
      hinted = true;
    }
    await page.getByText("Say the song or film out loud, then choose.").waitFor();
    await btn("I don't know this one").waitFor();
    if (!taken.has("11-menu")){
      await btn("Game menu").click();
      await page.getByText("Standings").waitFor();
      await shot("11-menu", 200);
      await page.keyboard.press("Escape");
      await page.getByText("Standings").waitFor({ state: "detached" });
    }
    if (turns === 3 && !resumed){
      await btn("Game menu").click();
      await btn("Home, keep the game").click();
      await btn("Resume").click();
      await handover.click();
      await know.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent === "I know this one" && !b.disabled), null, { timeout: 25000 });
      resumed = true;
    }
    const correct = turns % 3 !== 2;
    const before = (await saved(page)).game.history.length;
    const worth = Number((await page.getByText(/^Worth /).textContent()).match(/\d+/)[0]);
    await btn(correct ? "I know this one" : "I don't know this one").click();
    await page.getByRole("button", { name: /Pass it on|box office/ }).waitFor();
    if (await btn("Show the answer").count()) fail("extra reveal tap returned");
    if (await btn(/Got it|Missed/).count()) fail("post-reveal grading returned");
    await page.waitForFunction(n => JSON.parse(localStorage.getItem("tuneteasers_v7")).game.history.length === n + 1, before);
    const history = (await saved(page)).game.history;
    const scored = history.at(-1).points;
    if (correct ? scored > worth || scored < worth - 3 : scored !== 0) fail(`one-tap score ${scored} vs displayed worth ${worth}`);
    await shot("07-reveal", 100);
    await shot(correct ? "07b-reveal-correct" : "08-reveal-wrong", 1300);
    await page.getByRole("button", { name: /Pass it on|box office/ }).click();
    await page.getByRole("button", { name: /Pass it on|box office/ }).waitFor({ state: "detached" });
    turns++;
  }
  await shot("10-podium", 2600);

  const st = await saved(page);
  const g = st.game;
  const cast = g.cast;
  const expectedTurns = Number(A.rounds) * cast.length;
  if (!g.finished) fail("game not marked finished");
  if (g.history.length !== expectedTurns) fail(`history ${g.history.length} != ${expectedTurns}`);
  for (const c of cast){
    const sum = g.history.filter(h => h.id === c.id).reduce((n, h) => n + h.points, 0);
    if (sum !== c.score) fail(`${c.name}: score ${c.score} != history sum ${sum}`);
  }
  if (g.history.some(h => h.points !== 0 && (h.points < 10 || h.points > 120))) fail("points out of range");
  if (A.mode === "teams" && !cast.some(c => c.members.length)) fail("team members lost");
  const text = await page.locator("body").innerText();
  if (!/takes it|tie/.test(text)) fail("podium headline missing");
  if (errors.length) fail("page errors: " + errors.join(" | "));
  if (overflow.length) fail("screens scroll at this size: " + overflow.join(", "));
  if (!resumed) fail("home/resume path not exercised");
  if (categories.length){
    const corpus = JSON.parse(fs.readFileSync(new URL("../dist/corpus.json", import.meta.url), "utf8"));
    const lang = { hindi: "bolly", telugu: "telugu" };
    const tags = new Map(corpus.songs.map(r => Object.fromEntries(corpus.cols.map((c, i) => [c, r[i]])))
      .map(r => [`${lang[r.language]}|${songKey(r.title)}`, r.tags]));
    if (g.source !== "corpus") fail(`categories game drew from ${g.source}`);
    for (const t of g.queue){
      const tt = tags.get(`${t.lang}|${songKey(t.title)}`);
      if (!tt?.some(x => categories.includes(x))) fail(`"${t.title}" (${t.album}) carries ${JSON.stringify(tt)}, none of ${categories}`);
    }
  }
  console.log("PASS", JSON.stringify(A), `turns=${turns}`, cast.map(c => `${c.name}=${c.score}`).join(" "), `source=${g.source}`, `deadStreams=${deadStreams}`);
} catch (e){
  exit = 1;
  console.log("FAIL", JSON.stringify(A), e.message.split("\n").slice(0, 12).join(" / "));
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${A.profile}-FAIL.png`) }).catch(() => {});
} finally {
  await browser.close();
  server?.close();
  process.exit(exit);
}
