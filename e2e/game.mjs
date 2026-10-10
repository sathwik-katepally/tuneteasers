/* Plays one full show through the real UI against the real song sources and
   checks the scoring bookkeeping at the end.
   node e2e/game.mjs --profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both
     --difficulty=easy|medium|hard --rounds=3 [--categories=item,mass] [--reduced] [--no-worker] [--no-saavn] [--shots=dir] [--url=http://...]
   --no-worker makes the project's Worker unreachable (songs then come from the mirror).
   --no-saavn makes the Worker and every Saavn mirror unreachable and checks the show came
     from the baked catalog (Easy only: catalog clips have no Music-only windows).
   --categories picks those song categories (corpus tags) and checks every queued song carries one.
   It also spends the first contestant's "Heard it too much" skip (budget, same
   tier, title on screen, same contestant, tired cooldown) and forces one dead
   stream to check the stream-error skip stays free and records nothing. */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved, moreSettings } from "./harness.mjs";
import { displayTitle, songKey } from "../src/lib/utils.js";
import { SAAVN_BASES } from "../src/lib/constants.js";
import { CATEGORIES, HINT_PENALTY, SKIPS_PER_PLAYER, SPEED_BONUS_FADE_SECS, SPEED_BONUS_MAX } from "../src/lib/config.ts";

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
const songHistory = () => page.evaluate(() => ({
  played: JSON.parse(localStorage.getItem("tt_played") || "{}"),
  tired: JSON.parse(localStorage.getItem("tt_tired") || "{}"),
}));
const DEAD_HOST = "dead-stream.invalid";

let exit = 0;
try {
  if (A["no-worker"] === "true") await page.route(u => u.host === "tuneteasers-saavn.sathwik-katepally.workers.dev", r => r.abort("connectionrefused"));
  if (A["no-saavn"] === "true"){
    const hosts = new Set(SAAVN_BASES.map(b => new URL(b).host));
    await page.route(u => hosts.has(u.host), r => r.abort("connectionrefused"));
  }
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await page.getByRole("radio", { name: A.mode === "teams" ? "Teams" : "Solo" }).click();
  await page.getByRole("radio", { name: { bolly: "Hindi", telugu: "Telugu", both: "Both" }[A.mix], exact: true }).click();
  await moreSettings(page);
  await page.getByRole("radio", { name: A.difficulty, exact: false }).click();
  // The category counts load a moment after the fold opens and push the rounds control down.
  await page.getByRole("button", { name: /^Any, \d+ songs$/ }).waitFor();
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
  if (A["no-saavn"] === "true"){
    const crate = await page.waitForFunction(() => window.__ttLog.dump().findLast(e => e.tag === "crate")).then(h => h.jsonValue());
    if (crate.source !== "catalog") fail(`no-saavn show drew from ${crate.source}, not the catalog`);
  }

  await page.route(u => u.host === DEAD_HOST, r => r.abort("connectionrefused"));
  let turns = 0, extended = false, hinted = false, resumed = false, deadStreams = 0, heard = null, deadSkip = null;
  const expectMode = A.difficulty === "easy" ? ["plain"] : ["snip", "plain"];
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
    if (turns === 2 && !deadSkip){
      // A stream that dies: seed one into the saved queue and resume the game.
      await page.evaluate(host => {
        const s = JSON.parse(localStorage.getItem("tuneteasers_v7"));
        s.game.queue[s.game.trackIdx].stream = `https://${host}/gone.mp4`;
        localStorage.setItem("tuneteasers_v7", JSON.stringify(s));
      }, DEAD_HOST);
      await page.reload();
      await btn("Resume").click();
      await handover.waitFor();
      const g = (await saved(page)).game;
      deadSkip = { g, track: g.queue[g.trackIdx], history: await songHistory() };
    }
    await page.evaluate(() => { window.__ttLastMode = null; });
    await handover.click();
    await page.getByText("Ears on").waitFor();
    await shot("04-countdown", 900);
    const know = btn("I know this one");
    await know.waitFor();
    const heardBtn = btn(/^Heard it too much/);
    const awaitClip = async () => {
      // A dead stream is real life on Saavn: the game says so and offers Skip.
      for (let tries = 0; ; tries++){
        const dead = page.getByText(/Skip it to try another/);
        await Promise.race([
          page.waitForFunction(() => window.__ttLastMode, null, { timeout: 30000 }),
          dead.waitFor({ timeout: 30000 }),
        ]);
        if (!(await dead.isVisible())) break;
        if (tries === 2) fail("three dead streams in a row");
        if (await heardBtn.count()) fail("Heard it too much offered next to a stream-error skip");
        deadStreams++;
        await page.evaluate(() => { window.__ttLastMode = null; });
        const before = (await saved(page)).game;
        await btn("Skip this song").click();
        await page.getByText("Ears on").waitFor();
        if (deadSkip && !deadSkip.checked && before.queue[before.trackIdx].stream === deadSkip.track.stream){
          const g = (await saved(page)).game, h = await songHistory(), k = songKey(deadSkip.track.title);
          if (g.trackIdx !== deadSkip.g.trackIdx + 1 || g.turn !== deadSkip.g.turn) fail("error skip moved the turn");
          if (g.cast[g.turn].skips !== deadSkip.g.cast[g.turn].skips) fail("error skip spent a Heard-it skip");
          if (h.played[k] !== deadSkip.history.played[k] || h.tired[k]) fail("error skip put the dead song on cooldown");
          deadSkip.checked = true;
        }
      }
    };
    await awaitClip();
    if (turns === 2 && !deadSkip?.checked) fail("the seeded dead stream never showed its skip");
    const mode = await page.evaluate(() => window.__ttLastMode);
    if (!expectMode.includes(mode)) fail(`turn ${turns}: mode ${mode} not in ${expectMode}`);
    await shot("05-playing", 1200);
    if (turns < 2){
      await heardBtn.waitFor();
      // Playback is requested before the clip is flowing, and the link stays disabled while it loads.
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Heard it") && !b.disabled), null, { timeout: 25000 }).catch(() => {});
      const label = await heardBtn.textContent();
      if (!label.includes(`${SKIPS_PER_PLAYER} left`) || await heardBtn.isDisabled()) fail(`turn ${turns}: fresh contestant's skip reads "${label}"`);
    }
    if (turns === 0){
      // "Heard it too much": the title goes up, a same-tier song comes in, same contestant.
      const before = (await saved(page)).game;
      const track = before.queue[before.trackIdx];
      heard = { title: track.title, tier: track.tier ?? null, who: before.cast[before.turn].id };
      await page.evaluate(() => { window.__ttLastMode = null; });
      await heardBtn.click();
      await page.getByText("Skipped", { exact: true }).waitFor();
      if ((await page.getByText(displayTitle(track.title), { exact: true }).count()) !== 1) fail("skipped title not on screen");
      await shot("04b-skipped", 250);
      const g = (await saved(page)).game;
      const next = g.queue[g.trackIdx];
      if (g.trackIdx !== before.trackIdx + 1) fail("skip did not move to a new song");
      if (g.turn !== before.turn || g.cast[g.turn].id !== heard.who) fail("skip handed the turn on");
      if ((next.tier ?? null) !== heard.tier) fail(`replacement tier ${next.tier} != skipped ${heard.tier}`);
      if (g.cast[g.turn].skips !== 1) fail("skip not counted against the contestant");
      if (g.history.length !== before.history.length) fail("skip scored a turn");
      const h = await songHistory(), k = songKey(track.title);
      if (!(Date.now() - h.tired[k] < 60e3)) fail("skipped song not on the tired cooldown");
      if (h.played[k]) fail("skipped song also marked played");
      await awaitClip();
      await heardBtn.waitFor();
      if (!(await heardBtn.isDisabled()) || !(await heardBtn.textContent()).includes("Used")) fail("second skip still offered");
      await shot("05d-skip-used", 200);
    }
    if (!extended){
      await page.getByText("Guess, or hear more").waitFor({ timeout: 20000 });
      await shot("05b-listened", 200);
      await btn(/Hear 7s more/).click();
      await page.getByText(/s left/).waitFor({ timeout: 20000 });
      extended = true;
    }
    if (!hinted && turns === 1){
      // Every hint on one song: each one shows up and takes HINT_PENALTY off what it is worth.
      const g = (await saved(page)).game, t = g.queue[g.trackIdx];
      const want = [t.year > 0 && `Released in ${t.year}`, t.music && `Music by ${t.music}`, t.artist && `Sung by ${t.artist}`, t.album && `From ${t.album}`].filter(Boolean);
      for (let i = 0; i < want.length; i++){
        const hint = btn(new RegExp(`^Hint ${i + 1} of ${want.length}, costs ${HINT_PENALTY}$`));
        const before = Number((await page.getByText(/^Worth /).textContent()).match(/\d+/)[0]);
        await hint.click();
        await page.getByText(want[i], { exact: true }).waitFor();
        const after = Number((await page.getByText(/^Worth /).textContent()).match(/\d+/)[0]);
        if (after > before - HINT_PENALTY + 1 && after > 10) fail(`hint ${i + 1} took ${before - after}, not ${HINT_PENALTY}`);
      }
      if (!(await btn("No more hints").isDisabled())) fail("hint link still offered after the last hint");
      await shot("05c-hint", 300);
      hinted = true;
    }
    await page.getByText("Say the song or film out loud, then choose.").waitFor();
    await btn(/^I don.t know this one$|^Pass to /).waitFor();
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
    // Every third song is passed on and stolen, every third passed round the table with nobody knowing it.
    const pass = turns % 3 === 0 ? null : turns % 3 === 1 ? "steal" : "nobody";
    const correct = pass !== "nobody";
    const g0 = (await saved(page)).game;
    const before = g0.history.length;
    let scorer = g0.cast[g0.turn];
    if (pass){
      const passTo = btn(/^Pass to/);
      for (let hop = 1; ; hop++){
        if (!(await passTo.count())) break;
        const next = g0.cast[(g0.turn + hop) % g0.cast.length];
        if ((await passTo.textContent()).replace(/\s+/g, " ").trim() !== `Pass to ${next.name}`) fail(`pass button names ${await passTo.textContent()}, not ${next.name}`);
        await passTo.click();
        await page.getByText(new RegExp(`passed it to$`)).waitFor();
        if (!taken.has("06-steal-handover")) await shot("06-steal-handover", 900);
        await page.getByRole("button", { name: new RegExp(`^(It's with me|We're), ${next.name}|^We're ${next.name}, we'll take it$`) }).click();
        await page.getByText(`${next.name} is stealing`).waitFor();
        if (await heardBtn.count()) fail("Heard it too much offered to a stealer");
        const stolen = (await saved(page)).game;
        if (stolen.trackIdx !== g0.trackIdx || stolen.turn !== g0.turn) fail("a pass moved the song or the turn");
        scorer = next;
        if (pass === "steal") break;
        if (!taken.has("06b-stealing")) await shot("06b-stealing", 300);
      }
      if (pass === "nobody" && scorer.id === g0.cast[g0.turn].id && g0.cast.length > 1) fail("nobody pass never left the contestant");
    }
    const readAt = Date.now();
    const worth = Number((await page.getByText(/^Worth /).textContent()).match(/\d+/)[0]);
    if (pass === "steal" && (worth < 10 || worth > 60)) fail(`steal worth ${worth} is not half points`);
    const nobodyLink = btn("Nobody knows it");
    await (correct ? btn("I know this one") : (await nobodyLink.count()) ? nobodyLink : btn("I don't know this one")).click();
    // The bonus keeps fading between reading "Worth" and the tap; a busy machine stretches that gap.
    const fade = Math.ceil((Date.now() - readAt) / 1000 * SPEED_BONUS_MAX / SPEED_BONUS_FADE_SECS) + 1;
    await page.getByRole("button", { name: /Pass it on|box office/ }).waitFor();
    if (await btn("Show the answer").count()) fail("extra reveal tap returned");
    if (await btn(/Got it|Missed/).count()) fail("post-reveal grading returned");
    await page.waitForFunction(n => JSON.parse(localStorage.getItem("tuneteasers_v7")).game.history.length === n + 1, before);
    const history = (await saved(page)).game.history;
    const scored = history.at(-1).points;
    if (correct ? scored > worth || scored < worth - fade : scored !== 0) fail(`one-tap score ${scored} vs displayed worth ${worth}`);
    const credited = correct ? scorer.id : g0.cast[g0.turn].id;
    if (history.at(-1).id !== credited) fail(`song credited to ${history.at(-1).id}, not ${credited}`);
    if (pass === "steal") await page.getByText(`+${scored} for ${scorer.name},`, { exact: false }).waitFor();
    if (pass === "nobody") await page.getByText("Nothing for anyone").waitFor();
    if ((await saved(page)).game.turn !== (g0.turn + 1) % g0.cast.length && !(await saved(page)).game.finished) fail("the turn after a pass did not go to the next contestant");
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
  if (!heard) fail("Heard it too much not exercised");
  if (g.history.some(h => h.song === displayTitle(heard.title))) fail("skipped song was played later in the show");
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
  console.log("PASS", JSON.stringify(A), `turns=${turns}`, cast.map(c => `${c.name}=${c.score}`).join(" "), `source=${g.source}`, `deadStreams=${deadStreams}`, `skipped=${heard.tier ?? "untiered"}`);
} catch (e){
  exit = 1;
  console.log("FAIL", JSON.stringify(A), e.message.split("\n").slice(0, 12).join(" / "));
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${A.profile}-FAIL.png`) }).catch(() => {});
} finally {
  await browser.close();
  server?.close();
  process.exit(exit);
}
