/* The clip ladder, measured on the media clock, plus the countdown hand-off.
   One turn per run: the first clip, "Hear more" up the difficulty's ladder
   (src/lib/config.ts), then Replay. A 10ms
   sampler records every stretch of audible audio as media time (the element
   is playing, unmuted, its clock advancing, and for Music-only the gain gate
   open), so the checks are about sound, not about what the UI claims:
   - Easy plays window 0-5s, 5-12s, 12-20s, Replay 0-20s; Music-only 0-5s,
     5-12s, Replay 0-12s; with no repeated or skipped audio between rungs;
   - Music-only never sounds outside the verified interval;
   - no audio before the listening screen is fully faded in, and "Now
     playing" and the clip bar start with the sound.
   --window-at=0 (Music-only) serves only the verified windows that start at
   0s, so the first clip needs no seek to reach its start and must still not
   resume from wherever the hand-over prime left the element.
   node e2e/ladder.mjs --profile=phone|desktop --difficulty=easy|medium [--mix=both] [--window-at=0] [--log] [--shots=<dir>] */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved, moreSettings } from "./harness.mjs";
import { ladderFor } from "../src/lib/config.ts";
import { SNIP_WINDOW_SEC } from "../src/lib/constants.js";

const A = args({ profile: "desktop", difficulty: "easy", mix: "both", "window-at": "", log: "", shots: "" });
const music = A.difficulty !== "easy";
const L = ladderFor(!music);
const FULL = L.end(L.last);
// s of media time. Easy has no audio-clock gate, so its stop rides a JS timer
// that a busy machine can delay; seams are held tighter below.
const TOL = 0.15;

const instrument = () => {
  const T = window.__tl = [];
  const now = () => performance.now();
  const ev = (k, d = {}) => T.push({ t: now(), k, ...d });
  const els = new Set();
  const P = HTMLMediaElement.prototype, play = P.play;
  P.play = function(){ els.add(this); return play.call(this); };
  // currentTime only moves in coarse steps while playing, so a stretch is
  // read at its edges: where it started, and where the element paused (a
  // gated element pauses a few ms after its gate closes).
  let cur = null, ending = null;
  const close = () => { ev("silent", { from: ending.from, to: ending.el.currentTime, started: ending.t }); ending = null; };
  setInterval(() => {
    let on = null;
    for (const el of els){
      const gate = el._ttOut ? el._ttOut.gain.value : 1;
      if (!el.paused && !el.muted && !el.seeking && el.readyState >= 3 && gate > 0) on = el;
    }
    if (ending && (ending.el.paused || on || now() - ending.at > 100)) close();
    // A network stall mid-clip (still playing, not seeking, data run dry)
    // is the same stretch resuming, not a new clip.
    const stalled = cur && !on && !cur.el.paused && !cur.el.seeking && cur.el.readyState < 3;
    if (stalled && !cur.stall){ cur.stall = true; ev("stall", { at: cur.el.currentTime }); }
    if (on && cur) cur.stall = false;
    if (on && !cur){ cur = { el: on, from: on.currentTime, t: now() }; ev("audible", { from: cur.from }); }
    else if (!on && cur && !stalled){ ending = { ...cur, at: now() }; cur = null; }
  }, 10);
  const seen = {};
  const flip = (k, v) => { if (!!seen[k] !== v){ seen[k] = v; if (v) ev(k); } };
  const scan = () => {
    const txt = document.body?.textContent || "";
    flip("roll-it", txt.includes("Roll it"));
    const scr = [...document.querySelectorAll(".screen")].find(s => s.textContent.includes("is guessing"));
    flip("playing-mounted", !!scr);
    flip("playing-visible", !!scr && +getComputedStyle(scr).opacity >= 0.99);
    flip("now-playing", txt.includes("Now playing"));
    flip("clip-bar", !!document.querySelector('[class*="frameRun"]'));
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(scan, 8);
};

const server = await serve();
const { browser, context, page, errors } = await open(A.profile);
await context.addInitScript(instrument);
if (A["window-at"] !== ""){
  const at = Number(A["window-at"]);
  await context.route(/\/snips\.json(\?|$)/, async route => {
    const res = await route.fetch();
    const idx = await res.json();
    idx.snips = Object.fromEntries(Object.entries(idx.snips).filter(([, s]) => s.startSec === at));
    route.fulfill({ response: res, json: idx });
  });
}
const fail = m => { throw new Error(m); };
const btn = name => page.getByRole("button", { name });
const fmt = n => n.toFixed(2);
let exit = 0;
try {
  await page.goto(server.url);
  const mix = { bolly: "Hindi", telugu: "Telugu", both: "Both" }[A.mix];
  await page.getByRole("radio", { name: mix, exact: true }).click();
  await moreSettings(page);
  await page.getByRole("radio", { name: A.difficulty, exact: false }).click();
  await page.getByRole("radio", { name: "3", exact: true }).click();
  await btn(/Start the show/).click();
  const handover = btn(/^It's with me/);
  await handover.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  const listened = page.getByText("Guess, or hear more");
  const dead = page.getByText(/won't stream right now|isn't available/);
  for (let tries = 0; ; tries++){
    await page.evaluate(() => { window.__tl.length = 0; window.__ttClips = []; });
    if (tries === 0) await handover.click();
    await Promise.race([listened.waitFor({ timeout: 45000 }), dead.waitFor({ timeout: 45000 })]);
    if (!(await dead.isVisible())) break;
    if (tries === 2) fail("three dead streams in a row");
    await btn("Skip this song").click();
  }
  const tl0 = await page.evaluate(() => window.__tl.slice());
  const shot = async name => {
    if (!A.shots) return;
    fs.mkdirSync(A.shots, { recursive: true });
    await page.screenshot({ path: path.join(A.shots, `${A.profile}-${A.difficulty}-${name}.png`) });
  };
  const steps = L.segments.slice(1).map((sec, i) => [new RegExp(`^Hear ${sec}s more`), i ? 0 : 3000, i ? "" : "rung2"]);
  for (const [name, at, label] of [...steps, [/^Replay/, Math.round(FULL * 450), "replay"]]){
    await btn(name).click();
    await page.getByText(/\ds left/).waitFor({ timeout: 20000 });
    if (at){ await page.waitForTimeout(at); await shot(label); }
    await listened.waitFor({ timeout: 30000 });
  }
  if (await btn(/^Hear \d+s more/).count()) fail("a rung past the end of the ladder is offered");
  await shot("done");
  await page.waitForTimeout(300);
  const tl = await page.evaluate(() => window.__tl.slice());
  const clips = await page.evaluate(() => window.__ttClips);
  const mode = await page.evaluate(() => window.__ttLastMode);
  const st = await saved(page);
  const track = st.game.queue[st.game.trackIdx];
  const hook = t => (t.duration > 35 ? Math.min(45, Math.max(0, t.duration - 60)) : 0);
  if (mode !== (music ? "snip" : "plain")) fail(`played mode ${mode}`);
  const W = music ? track.snip.startSec : hook(track);
  if (music && track.snip.endSec - W !== SNIP_WINDOW_SEC) fail(`snip window is ${track.snip.endSec - W}s, not ${SNIP_WINDOW_SEC}s`);

  // The engine reads media time synchronously when each clip starts playing
  // and right after it pauses; the sampler independently confirms there were
  // one audible stretch per rung plus the replay, and that none escaped the window.
  const heard = tl.filter(e => e.k === "silent").map(e => ({ from: e.from - W, to: e.to - W }));
  const expected = [...L.segments.map((_, i) => [L.start(i), L.end(i)]), [0, FULL]];
  const spans = clips.slice(-expected.length).map(c => ({ from: c.from - W, to: c.to - W }));
  const show = list => list.map(s => `[${fmt(s.from)}, ${fmt(s.to)}]`).join(" ");
  console.log(`${A.profile} ${A.difficulty}: window starts at ${fmt(W)}s of "${track.title.slice(0, 30)}"`);
  console.log(`  clip media spans, engine (s into window): ${show(spans)}`);
  console.log(`  audible stretches, sampler (s into window): ${show(heard)}`);
  if (heard.length !== expected.length || clips.length !== expected.length)
    fail(`expected ${expected.length} clips, engine ran ${clips.length} and ${heard.length} were heard`);
  expected.forEach(([a, b], i) => {
    if (Math.abs(spans[i].from - a) > TOL || Math.abs(spans[i].to - b) > TOL)
      fail(`play ${i + 1} covered [${fmt(spans[i].from)}, ${fmt(spans[i].to)}], expected [${a}, ${b}]`);
  });
  for (let i = 1; i <= L.last; i++){
    const overlap = spans[i - 1].to - spans[i].from;
    console.log(`  rung ${i} -> ${i + 1} seam: ${overlap >= 0 ? `${fmt(overlap * 1000)}ms repeated` : `${fmt(-overlap * 1000)}ms skipped`}`);
    if (Math.abs(overlap) > 0.08) fail(`rung ${i} -> ${i + 1} seam off by ${fmt(overlap)}s`);
  }
  if (music && heard.concat(spans).some(s => s.from < -0.02 || s.to > SNIP_WINDOW_SEC + 0.1)) fail("music-only sounded outside its verified interval");

  const at = k => tl0.find(e => e.k === k)?.t;
  const first = tl0.find(e => e.k === "audible")?.t;
  const roll = at("roll-it"), visible = at("playing-visible"), mounted = at("playing-mounted");
  const rel = t => (t === undefined ? "never" : `${Math.round(t - roll)}ms`);
  console.log(`  hand-off (from "Roll it"): playing mounted ${rel(mounted)}, fully visible ${rel(visible)}, audio ${rel(first)}, "Now playing" ${rel(at("now-playing"))}, clip bar ${rel(at("clip-bar"))}`);
  if (!roll || !visible || !first) fail("hand-off events missing");
  if (first < visible) fail(`audio started ${Math.round(visible - first)}ms before the listening screen was visible`);
  for (const k of ["now-playing", "clip-bar"]){
    const d = at(k) - first;
    if (!(Math.abs(d) <= 150)) fail(`${k} is ${Math.round(d)}ms off the audio start`);
  }
  if (A.log) for (const e of tl) console.log(`  ${Math.round(e.t - roll)}`.padStart(8), e.k, JSON.stringify({ ...e, t: undefined, k: undefined }));
  if (errors.length) fail("page errors: " + errors.join(" | "));
  console.log(`PASS ladder ${A.profile} ${A.difficulty}`);
} catch (e){
  exit = 1;
  console.log(`FAIL ladder ${A.profile} ${A.difficulty}:`, e.message.split("\n")[0]);
} finally { await browser.close(); server.close(); }
process.exit(exit);
