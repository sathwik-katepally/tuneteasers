/* The landing page: shown on a first visit only, skipped by room and group
   links and by anyone with a save, reachable again from the About button,
   and a phone leaving a room goes back to where it came from. It must fit
   every phone without scrolling and show the clip ladder from config.
   Usage: node e2e/landing.mjs [--profile=phone|desktop] [--shots=<dir>] */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args } from "./harness.mjs";
import { ladderFor } from "../src/lib/config.ts";

const A = args({ profile: "phone" });
const server = await serve();
const url = server.url;
const { browser, page, errors } = await open(A.profile, { landing: true });
const shots = A.shots ? path.resolve(A.shots) : "";
if (shots) fs.mkdirSync(shots, { recursive: true });

const results = [];
async function check(name, fn){
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e){ results.push(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
const expect = (ok, msg) => { if (!ok) throw new Error(msg); };
const btn = name => page.getByRole("button", { name, exact: true });
const landing = () => page.getByRole("heading", { name: "Which film is this song from?" });
const setup = () => page.getByText("Tonight's show");
const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${A.profile}-${name}.png`) }); };

/* A first visit: storage emptied from a non-app page, then the app opens. */
async function firstVisit(hash = "", seed = null){
  await page.goto(url + "seed.html");
  await page.evaluate(s => { localStorage.clear(); for (const [k, v] of Object.entries(s || {})) localStorage.setItem(k, JSON.stringify(v)); }, seed);
  await page.goto(url + hash);
}

const track = n => ({ title: `Song ${n}`, artist: "Singer", stream: `https://aac.saavncdn.com/test/${n}.mp4`, duration: 240, year: 2012 });
const SAVED_GAME = {
  v: 7,
  settings: { play: "pass", mix: "both", difficulty: "easy", mode: "players", rounds: 3 },
  players: [{ id: "p1", name: "Asha", members: [] }, { id: "p2", name: "Ravi", members: [] }],
  game: { queue: [1, 2, 3, 4, 5, 6].map(track), trackIdx: 1, turn: 1, round: 1, totalRounds: 3, difficulty: "easy",
    cast: [{ id: "p1", name: "Asha", members: [], score: 100 }, { id: "p2", name: "Ravi", members: [], score: 0 }],
    history: [{ id: "p1", song: "Song 1", points: 100, round: 1 }] },
};

try {
  await check("first visit shows the landing page", async () => {
    await firstVisit();
    await landing().waitFor({ timeout: 8000 });
    await page.waitForTimeout(900);
    await shot("landing");
  });

  await check("the ladder is the one in config", async () => {
    const rungs = await page.locator("ol li").allInnerTexts();
    const easy = ladderFor(true);
    const want = easy.segments.map((s, i) => `${i ? "+" : ""}${s}s ${easy.points[i]} pts`);
    const got = rungs.map(r => r.replace(/\s+/g, " ").trim().toLowerCase());
    expect(JSON.stringify(got) === JSON.stringify(want.map(w => w.toLowerCase())), `ladder ${JSON.stringify(got)}, config ${JSON.stringify(want)}`);
  });

  await check("the landing fits every screen without scrolling", async () => {
    const sizes = A.profile === "phone" ? [[320, 568], [375, 667], [393, 659], [430, 739]] : [[1440, 900], [1280, 720], [1024, 768]];
    const bad = [];
    for (const [w, h] of sizes){
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
      if (m.x > 0 || m.y > 0) bad.push(`${w}x${h} spills ${m.x}px across, ${m.y}px down`);
    }
    await page.setViewportSize(A.profile === "phone" ? { width: 390, height: 664 } : { width: 1440, height: 900 });
    expect(!bad.length, bad.join("; "));
  });

  await check("Set up a game opens setup, with an About button", async () => {
    await btn("Set up a game").click();
    await setup().waitFor();
    await btn("About").waitFor();
    await shot("setup");
  });

  await check("a return visit lands on setup", async () => {
    await page.reload();
    await setup().waitFor();
    expect(!(await landing().count()), "landing shown again after a reload");
  });

  await check("About brings the landing back, and it leads to setup again", async () => {
    await btn("About").click();
    await landing().waitFor();
    await btn("Set up a game").click();
    await setup().waitFor();
  });

  await check("join from setup goes back to setup", async () => {
    await btn("Join with a code").click();
    await page.getByLabel("Room code").waitFor();
    await btn("Back to the start").click();
    await setup().waitFor();
  });

  await check("join from the landing goes back to the landing", async () => {
    await firstVisit();
    await landing().waitFor();
    await btn("Join with a code").click();
    await page.getByLabel("Room code").waitFor();
    await shot("join");
    await btn("Back to the start").click();
    await landing().waitFor();
  });

  await check("a room link on a first visit skips the landing, and leaving shows it", async () => {
    await firstVisit("#room=BCDF");
    await page.getByLabel("Room code").waitFor();
    expect(await page.getByLabel("Room code").inputValue() === "BCDF", "room code not taken from the link");
    expect(!(await landing().count()), "landing shown for a room link");
    await btn("Back to the start").click();
    await landing().waitFor();
  });

  await check("a room link opened on setup goes back to setup", async () => {
    await page.goto(url + "seed.html");
    await page.goto(url);
    await setup().waitFor();
    await page.evaluate(() => { location.hash = "#room=BCDF"; });
    await page.getByLabel("Room code").waitFor();
    await btn("Back to the start").click();
    await setup().waitFor();
  });

  await check("a room link on a return visit goes back to setup", async () => {
    await page.goto(url + "seed.html");
    await page.goto(url + "#room=BCDF");
    await page.getByLabel("Room code").waitFor();
    await btn("Back to the start").click();
    await setup().waitFor();
  });

  await check("a group invite link on a first visit skips the landing", async () => {
    await firstVisit("#join=not-an-invite");
    await setup().waitFor();
    expect(!(await landing().count()), "landing shown for a group invite link");
  });

  await check("a saved game lands on setup with its Resume card", async () => {
    await firstVisit("", { tuneteasers_v7: SAVED_GAME });
    await setup().waitFor();
    await page.getByText("Show in progress").waitFor();
    expect(!(await landing().count()), "landing shown over a saved game");
  });

  await check("a save from the old version counts as a return visit", async () => {
    await firstVisit("", { tuneteasers_v6: { settings: { mix: "both" }, players: [{ name: "Asha", score: 2 }] } });
    await setup().waitFor();
    expect(!(await landing().count()), "landing shown to a player of the old version");
  });

  await check("no page errors", async () => { expect(!errors.length, errors.join(" | ")); });
} finally {
  await browser.close();
  server.close();
}

console.log(`landing e2e (${A.profile})\n` + results.join("\n"));
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
