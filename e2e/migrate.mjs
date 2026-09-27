/* A saved game from the pre-points version (tuneteasers_v6) must survive the
   upgrade: it is offered for resume, scores are rescaled, and a turn plays on
   top of it. Garbage in the old key must not crash the app.
   node e2e/migrate.mjs [--profile=phone|desktop] */
import { serve, open, args, saved } from "./harness.mjs";
import { displayTitle } from "../src/lib/utils.js";

const A = args({ profile: "phone" });
const SAAVN = "https://tuneteasers-saavn.sathwik-katepally.workers.dev/api/search/songs?query=arijit%20singh%20hits&limit=12";
const fail = msg => { throw new Error(msg); };

const res = await (await fetch(SAAVN)).json();
const queue = res.data.results.map(s => ({
  title: s.name, artist: s.artists.primary.map(a => a.name).join(", "), album: s.album.name,
  art: s.image.at(-1).url, stream: s.downloadUrl.find(d => d.quality === "96kbps").url,
  duration: s.duration, year: Number(s.year), lang: "bolly", hook: false,
}));
const v6 = {
  settings: { mix: "bolly", sound: "full", snippetLen: 15, eras: ["2010s", "2020s"] },
  players: [{ name: "Priya", score: 2.5 }, { name: "Rahul", score: 1 }, { name: "Anu", score: 0 }],
  game: { queue, trackIdx: 4, turn: 1, round: 2, totalSongs: queue.length, source: "saavn" },
};

const server = await serve();
const { browser, page, errors } = await open(A.profile);
let exit = 0;
try {
  // Seed storage from a same-origin page that is not the app, so the app's
  // own first save cannot race the seeding.
  await page.goto(server.url + "seed.html");
  await page.evaluate(v => { localStorage.clear(); localStorage.setItem("tuneteasers_v6", JSON.stringify(v)); }, v6);
  await page.goto(server.url);
  await page.getByText("Show in progress").waitFor();
  const line = await page.getByText(/Round 2 of \d+, Rahul is up next/).textContent();
  for (const n of ["Priya", "Rahul", "Anu"]) await page.getByRole("button", { name: `Rename ${n}` }).waitFor();
  if (await page.getByRole("radio", { name: "Easy" }).getAttribute("aria-checked") !== "true") fail("old With-vocals setting did not map to Easy");
  if (await page.getByRole("radio", { name: "Hindi" }).getAttribute("aria-checked") !== "true") fail("mix lost");

  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("button", { name: "It's with me, Rahul" }).click();
  await page.getByRole("button", { name: "I know this one" }).waitFor();
  await page.waitForFunction(() => window.__ttLastMode, null, { timeout: 25000 });
  await page.getByRole("button", { name: "I know this one" }).click();
  const verdict = await page.getByText(/\+\d+ for Rahul, \d+ in total/).textContent();
  const pts = Number(verdict.match(/\+(\d+)/)[1]);
  const title = await page.locator("h2").first().textContent();
  if (title !== displayTitle(queue[4].title)) fail(`resumed at the wrong song: ${title} vs ${queue[4].title}`);
  await page.getByText(new RegExp(`\\+${pts} for Rahul, ${100 + pts} in total`)).waitFor();
  await page.waitForTimeout(300);
  const st = await saved(page);
  const scores = st.game.cast.map(c => c.score).join(",");
  if (scores !== `250,${100 + pts},0`) fail(`scores after resume ${scores}`);
  if (st.game.turn !== 2 || st.game.trackIdx !== 5) fail("turn did not advance");
  if (await page.evaluate(() => localStorage.getItem("tuneteasers_v6"))) fail("legacy key not dropped");

  for (const junk of ['{"players":"x","game":{"queue":[{}],"turn":"z"}}', "not json", '{"settings":{"eras":"2000s"},"game":{"queue":[{"stream":"http://x"}],"trackIdx":9}}']){
    await page.goto(server.url + "seed.html");
    await page.evaluate(j => { localStorage.clear(); localStorage.setItem("tuneteasers_v6", j); }, junk);
    await page.goto(server.url);
    await page.getByRole("button", { name: /Start the show/ }).waitFor();
    if (await page.getByText("Show in progress").count()) fail("junk save offered for resume: " + junk);
  }
  if (errors.length) fail("page errors: " + errors.join(" | "));
  console.log("PASS migrate", A.profile, `"${line}"`, `resumed song="${title}"`, `scores=250,${100 + pts},0`);
} catch (e){
  exit = 1;
  console.log("FAIL migrate", A.profile, e.message.split("\n").slice(0, 8).join(" / "));
} finally {
  await browser.close();
  server.close();
  process.exit(exit);
}
