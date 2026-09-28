/* How much a person has to tap, read and decide on the way to the first song,
   counted the way the UX audit did (docs/testing-and-deploy.md): words summed
   over every screen before the first song, choices on the busiest screen, and
   a radio group counts as one choice. Fails when first run grows past its
   budget or a returning player needs more than one tap to start.
   Usage: node e2e/journeys.mjs [--shots=<dir>] */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args } from "./harness.mjs";

const A = args({});
const BUDGET = { words: 180, choices: 12, taps: 3 };
const server = await serve();
const shots = A.shots ? path.resolve(A.shots) : "";
if (shots) fs.mkdirSync(shots, { recursive: true });
const report = [];
const fails = [];

function tally(journey, profile){
  const t = { journey, profile, taps: 0, screens: [] };
  report.push(t);
  return {
    t,
    async tap(loc){ await loc.click(); t.taps++; },
    async measure(page, screen){
      await page.waitForTimeout(700);
      const m = await page.evaluate(() => {
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
        const ctl = [...document.querySelectorAll("button, input, a[href], select, textarea")].filter(e => vis(e) && !e.disabled && !e.closest("[aria-hidden=true]"));
        const choices = new Set(ctl.map(e => e.closest("[role=radiogroup]") || e)).size;
        const words = (document.body.innerText.match(/[\p{L}\p{N}'’]+/gu) || []).length;
        return { words, choices, scroll: +(document.documentElement.scrollHeight / innerHeight).toFixed(2) };
      });
      if (shots) await page.screenshot({ path: path.join(shots, `journey-${journey}-${profile}-${t.screens.length + 1}-${screen}.png`), fullPage: true });
      t.screens.push({ screen, ...m });
      return m;
    },
  };
}
const btn = (page, name) => page.getByRole("button", { name });

async function firstRun(profile, mode){
  const { browser, page, errors } = await open(profile, { landing: true });
  const T = tally(`first-${mode}`, profile);
  await page.goto(server.url);
  await T.measure(page, "landing");
  await T.tap(btn(page, mode === "pass" ? /^Pass one phone/ : /^Buzz in from every phone/));
  await page.getByText("Tonight's show").waitFor();
  const setup = await T.measure(page, "setup");
  if (setup.choices > BUDGET.choices) fails.push(`${profile} ${mode} setup has ${setup.choices} choices`);
  if (mode === "pass"){
    await T.tap(btn(page, /Start the show/));
    await btn(page, /^It's with me|roll it$/).waitFor({ timeout: 60000 });
    await T.measure(page, "handover");
    await T.tap(btn(page, /^It's with me|roll it$/));
    await page.getByText("Ears on").waitFor();
    await T.measure(page, "countdown");
    await page.waitForFunction(() => /now playing|tap to play|clip over/i.test(document.body.innerText), null, { timeout: 40000 });
    await T.measure(page, "first-song");
    T.t.words = T.t.screens.filter(x => x.screen !== "first-song").reduce((n, x) => n + x.words, 0);
    if (T.t.words > BUDGET.words) fails.push(`${profile} first run reads ${T.t.words} words`);
    if (T.t.taps > BUDGET.taps) fails.push(`${profile} first run takes ${T.t.taps} taps`);
    // Returning: the next visit remembers everything, so Start is the only tap.
    await page.getByRole("button", { name: "Game menu" }).click();
    await page.getByRole("button", { name: "End game" }).click();
    await page.getByRole("button", { name: "End it" }).click();
    await page.reload();
    const R = tally("returning", profile);
    await page.getByText("Tonight's show").waitFor();
    await R.measure(page, "setup");
    await R.tap(btn(page, /Start the show/));
    await btn(page, /^It's with me|roll it$/).waitFor({ timeout: 60000 });
    if (R.t.taps !== 1) fails.push(`${profile} returning player took ${R.t.taps} taps`);
  }
  if (errors.length) fails.push(`${profile} ${mode} page errors: ${errors.join(" | ")}`);
  await browser.close();
}

try {
  for (const profile of ["phone", "desktop"]) for (const mode of ["pass", "room"]) await firstRun(profile, mode);
} finally {
  server.close();
}
for (const r of report){
  console.log(`${r.journey} (${r.profile}) taps=${r.taps}${r.words ? ` words=${r.words}` : ""}`);
  for (const s of r.screens) console.log(`  ${s.screen.padEnd(10)} words=${String(s.words).padStart(4)} choices=${String(s.choices).padStart(3)} scroll=${s.scroll}`);
}
if (fails.length){ console.log("FAIL journeys\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS journeys");
