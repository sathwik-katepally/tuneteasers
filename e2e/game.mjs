/* Plays one full show through the real UI against the real song sources and
   checks the scoring bookkeeping at the end.
   node e2e/game.mjs --profile=phone|desktop --mode=players|teams --mix=both|hindi,english|...
     --difficulty=easy|medium --rounds=3 [--categories=item,mass] [--reduced] [--no-worker] [--no-saavn] [--shots=dir] [--url=http://...]
   --no-worker makes the project's Worker unreachable (songs then come from the mirror).
   --no-saavn makes the Worker and every Saavn mirror unreachable and checks the show came
     from the baked catalog (Easy only: catalog clips have no Music-only windows).
   --categories picks those song categories (corpus tags) and checks every queued song carries one.
   It also has the first contestant skip a song (title on screen, same
   contestant, nothing recorded), skip the next one while its clip is still
   cueing on a stream too slow to start, and forces one dead stream to check
   the skip after a stream error moves on the same way and records nothing.
   A later song's stream answers 404 with no CORS header, as Saavn's CDN does
   for a song it has lost: the game offers its skip and the browser's CORS
   error is no page error, while the same 404 from the Worker still is one. */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved, moreSettings, pickLangs, countsSettled, WORKER_HOST } from "./harness.mjs";
import { displayTitle, songKey } from "../src/lib/utils.js";
import { SAAVN_BASES } from "../src/lib/constants.js";
import { CATEGORIES, DIFFICULTY, HINT_PENALTY, SPEED_BONUS_FADE_SECS, SPEED_BONUS_MAX } from "../src/lib/config.ts";
import { LANGUAGES, isFilmLang } from "../src/lib/languages.ts";

const A = args({ profile: "phone", mode: "players", mix: "both", difficulty: "medium", rounds: "3" });
// --mix: "both" (Hindi and Telugu) or a comma list of language ids.
const langLabels = mix => (mix === "both" ? "hindi,telugu" : mix).split(",").map(id => {
  const l = LANGUAGES.find(x => x.id === id);
  if (!l) throw new Error(`unknown language ${id}`);
  return l.label;
});
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
const songHistory = () => page.evaluate(() => JSON.parse(localStorage.getItem("tt_played") || "{}"));
const DEAD_HOST = "dead-stream.invalid";
/* Playwright adds an Access-Control-Allow-Origin that admits the page to any
   fulfilled cross-origin response without one, so a header naming another
   origin stands in for the missing one: the browser rejects both alike. */
const noCors404 = route => route.fulfill({ status: 404, headers: { "access-control-allow-origin": "https://elsewhere.invalid" }, body: "" });

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
  const probe = `https://${WORKER_HOST}/e2e-no-cors`;
  await page.route(u => u.href === probe, noCors404);
  const seen = errors.length, corsError = /Access-Control-Allow-Origin|CORS policy/;
  await page.evaluate(u => fetch(u).catch(() => {}), probe);
  const probed = errors.splice(seen);
  if (!probed.some(e => corsError.test(e))) fail(`a Worker 404 without CORS was not a page error (recorded: ${probed.join(" | ") || "nothing"})`);
  // WebKit reports the failed fetch as a page error, which Playwright cuts at its first colon: the URL's.
  errors.push(...probed.filter(e => !corsError.test(e) && !e.includes(probe.slice("https://".length))));
  await page.getByRole("radio", { name: A.mode === "teams" ? "Teams" : "Players" }).click();
  await pickLangs(page, langLabels(A.mix));
  await moreSettings(page);
  await page.getByRole("radio", { name: DIFFICULTY[A.difficulty].label, exact: true }).click();
  // Counts for the new sound land a moment later and push the rounds control down.
  await countsSettled(page);
  await page.getByRole("radio", { name: A.rounds, exact: true }).click();
  const categories = A.categories ? A.categories.split(",") : [];
  for (const id of categories){
    const label = CATEGORIES.find(c => c.id === id)?.label ?? fail(`unknown category ${id}`);
    const chip = page.getByRole("button", { name: new RegExp(`^${label}, \\d+ songs$`) });
    await chip.click();
    if (await chip.getAttribute("aria-pressed") !== "true") fail(`${label} did not select`);
  }
  if (A.mode === "teams"){
    const who = page.getByLabel("Who's on it").first();
    await who.fill("Priya, Rahul"); await page.keyboard.press("Enter");
  } else {
    await btn("Add").click(); await page.keyboard.type("Anu"); await page.keyboard.press("Enter");
    // --player-lang=english: Anu's own turns play only that language.
    if (A["player-lang"]){
      await btn("Give someone one language").click();
      await page.getByLabel("Anu's songs").selectOption(A["player-lang"]);
    }
  }
  await shot("01-setup");
  await btn(/Start the show/).click();
  await shot("02-loading", 450);
  if (A["no-saavn"] === "true"){
    const crate = await page.waitForFunction(() => window.__ttLog.dump().findLast(e => e.tag === "crate")).then(h => h.jsonValue());
    if (crate.source !== "catalog") fail(`no-saavn show drew from ${crate.source}, not the catalog`);
  }

  await page.route(u => u.host === DEAD_HOST, r => r.abort("connectionrefused"));
  let langTurns = 0;
  let turns = 0, extended = false, hinted = false, resumed = false, deadStreams = 0, heard = null, deadSkip = null, nobodyCued = false, gone = null;
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
    if (turns === 3 && !gone){
      // The next song is already loading in the background; the one after it has not been asked for.
      const g = (await saved(page)).game;
      const stream = g.queue[g.trackIdx + 2]?.stream ?? fail("no song two ahead to answer 404");
      gone = { stream, skipped: false };
      await page.route(u => u.href === new URL(stream).href, noCors404);
    }
    if (A["player-lang"]){
      const g = (await saved(page)).game, c = g.cast[g.turn], t = g.queue[g.trackIdx];
      if (c.lang && t.lang !== c.lang) fail(`${c.name}'s turn plays ${t.lang} ("${t.title}"), not ${c.lang}`);
      if (c.lang) langTurns++;
    }
    await page.evaluate(() => { window.__ttLastMode = null; });
    await handover.click();
    await page.getByText("Ears on").waitFor();
    await shot("04-countdown", 900);
    const know = btn("I know this one");
    await know.waitFor();
    const skipBtn = btn("Skip this song");
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
        deadStreams++;
        await page.evaluate(() => { window.__ttLastMode = null; });
        const before = (await saved(page)).game;
        if (before.queue[before.trackIdx].stream === gone?.stream) gone.skipped = true;
        await skipBtn.click();
        await page.getByText("Another one").waitFor();
        if (deadSkip && !deadSkip.checked && before.queue[before.trackIdx].stream === deadSkip.track.stream){
          const g = (await saved(page)).game, h = await songHistory(), k = songKey(deadSkip.track.title);
          if (g.trackIdx !== deadSkip.g.trackIdx + 1 || g.turn !== deadSkip.g.turn) fail("error skip moved the turn");
          if (h[k] !== deadSkip.history[k]) fail("error skip put the dead song on cooldown");
          deadSkip.checked = true;
        }
      }
    };
    await awaitClip();
    if (turns === 2 && !deadSkip?.checked) fail("the seeded dead stream never showed its skip");
    const mode = await page.evaluate(() => window.__ttLastMode);
    if (!expectMode.includes(mode)) fail(`turn ${turns}: mode ${mode} not in ${expectMode}`);
    await shot("05-playing", 1200);
    // Playback is requested before the clip is flowing, and the link works while it loads.
    if (turns < 2){
      await skipBtn.waitFor();
      if (await skipBtn.isDisabled()) fail(`turn ${turns}: skip not offered to a fresh contestant`);
    }
    if (turns === 0){
      // Skip: the title goes up, the next song comes in, same contestant, nothing recorded.
      const before = (await saved(page)).game;
      const track = before.queue[before.trackIdx];
      heard = { title: track.title, who: before.cast[before.turn].id };
      // The next song's stream is too slow to start: play() never settles, so its clip stays cueing.
      await page.evaluate(() => {
        const P = HTMLMediaElement.prototype, real = P.play;
        window.__ttStall = true;
        P.play = function(){ return window.__ttStall ? new Promise(() => {}) : real.call(this); };
        window.__ttLastMode = null;
      });
      await skipBtn.click();
      await page.getByText("Skipped", { exact: true }).waitFor();
      if ((await page.getByText(displayTitle(track.title), { exact: true }).count()) !== 1) fail("skipped title not on screen");
      await shot("04b-skipped", 250);
      const g = (await saved(page)).game;
      if (g.trackIdx !== before.trackIdx + 1) fail("skip did not move to a new song");
      if (g.turn !== before.turn || g.cast[g.turn].id !== heard.who) fail("skip handed the turn on");
      if (g.history.length !== before.history.length) fail("skip scored a turn");
      const h = await songHistory(), k = songKey(track.title);
      if (h[k]) fail("skipped song recorded as played");
      if (await page.evaluate(() => localStorage.getItem("tt_tired"))) fail("skip wrote the old tired history");
      await awaitClip();
      await page.getByText("Threading the film").waitFor();
      if (await skipBtn.isDisabled()) fail("skip locked while a slow clip is cueing");
      await shot("05d-skip-again", 200);
      const slow = (await saved(page)).game;
      await page.evaluate(() => { window.__ttStall = false; window.__ttLastMode = null; });
      await skipBtn.click();
      await page.getByText("Skipped", { exact: true }).waitFor();
      const next = (await saved(page)).game;
      if (next.trackIdx !== slow.trackIdx + 1 || next.turn !== slow.turn) fail("skip while cueing did not bring the same contestant a new song");
      await awaitClip();
    }
    if (!extended){
      // "Hear more" starts at the next rung, so mid-clip it would jump past the seconds not heard yet.
      await page.getByText(/\ds left/).waitFor({ timeout: 20000 });
      if (!(await btn(/Hear 7s more/).isDisabled())) fail("Hear more offered while the clip is still playing");
      await page.getByText("Guess, or hear more").waitFor({ timeout: 20000 });
      await shot("05b-listened", 200);
      await btn(/Hear 7s more/).click();
      await page.getByText(/s left/).waitFor({ timeout: 20000 });
      extended = true;
    }
    if (!hinted && turns === 1){
      // Every hint on one song: each one shows up and takes HINT_PENALTY off what it is worth.
      const g = (await saved(page)).game, t = g.queue[g.trackIdx];
      // A film song names its film last, an English song its artist.
      const want = (isFilmLang(t.lang)
        ? [t.year > 0 && `Released in ${t.year}`, t.music && `Music by ${t.music}`, t.artist && `Sung by ${t.artist}`, t.album && `From ${t.album}`]
        : [t.year > 0 && `Released in ${t.year}`, t.album && `From the album ${t.album}`, t.artist && `By ${t.artist}`]).filter(Boolean);
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
    const now = (await saved(page)).game, nowTrack = now.queue[now.trackIdx];
    await page.getByText(`Say the song or ${isFilmLang(nowTrack.lang) ? "film" : "artist"} out loud, then choose.`).waitFor();
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
        if (await skipBtn.count() && !(await page.getByText(/Skip it to try another/).count())) fail("skip offered to a stealer");
        const stolen = (await saved(page)).game;
        if (stolen.trackIdx !== g0.trackIdx || stolen.turn !== g0.turn) fail("a pass moved the song or the turn");
        scorer = next;
        if (pass === "steal") break;
        if (!taken.has("06b-stealing")) await shot("06b-stealing", 300);
        if (pass === "nobody" && !nobodyCued && await btn("Nobody knows it").count()){
          // A stealer whose replay is stuck on a stream too slow to start can still end the song.
          nobodyCued = true;
          await page.evaluate(() => {
            const P = HTMLMediaElement.prototype, real = P.play;
            window.__ttStall = true;
            P.play = function(){ return window.__ttStall ? new Promise(() => {}) : real.call(this); };
          });
          await btn("Replay").click();
          await page.getByText("Threading the film").waitFor();
          if (await btn("Nobody knows it").isDisabled()) fail("Nobody knows it locked while a slow clip is cueing");
          await page.evaluate(() => { window.__ttStall = false; });
          break;
        }
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
  // A tab that iOS reloads after the last song comes back on the podium with the result intact.
  // The index is seeded one past the last song, where a show that ran its queue dry ends.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("tuneteasers_v7"));
    s.game.trackIdx = s.game.queue.length;
    localStorage.setItem("tuneteasers_v7", JSON.stringify(s));
  });
  await page.reload();
  await btn("Same crowd again").waitFor();
  const kept = (await saved(page)).game;
  const scores = c => c.map(x => `${x.name}=${x.score}`).join(" ");
  if (!kept?.finished || scores(kept.cast) !== scores(cast)) fail("a reload on the podium lost the final scores");
  if (!/takes it|tie/.test(await page.locator("body").innerText())) fail("podium headline missing after a reload");
  await btn("New show").click();
  await btn(/Start the show/).waitFor();
  if (await page.getByText("Show in progress").count()) fail("finished game offered for resume");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("tuneteasers_v7")).game === null);
  if (errors.length) fail("page errors: " + errors.join(" | "));
  if (overflow.length) fail("screens scroll at this size: " + overflow.join(", "));
  if (!resumed) fail("home/resume path not exercised");
  if (A["player-lang"] && !langTurns) fail("no turn had a player's own language");
  if (!heard) fail("skip not exercised");
  if (!gone?.skipped) fail("the stream that answered 404 without CORS never offered its skip");
  if (g.history.some(h => h.song === displayTitle(heard.title))) fail("skipped song was played later in the show");
  if (categories.length){
    const corpus = JSON.parse(fs.readFileSync(new URL("../dist/corpus.json", import.meta.url), "utf8"));
    const tags = new Map(corpus.songs.map(r => Object.fromEntries(corpus.cols.map((c, i) => [c, r[i]])))
      .map(r => [`${r.language}|${songKey(r.title)}`, r.tags]));
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
