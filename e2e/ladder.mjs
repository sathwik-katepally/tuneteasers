/* The clip ladder, measured on the media clock, plus the countdown hand-off.
   One turn per run: the first clip, "Hear more" twice, then Replay. A 10ms
   sampler records every stretch of audible audio as media time (the element
   is playing, unmuted, its clock advancing, and for Music-only the gain gate
   open), so the checks are about sound, not about what the UI claims:
   - rung 1 plays window 0-5s, rung 2 5-12s, rung 3 12-20s, Replay 0-20s,
     with no repeated or skipped audio between rungs;
   - Music-only never sounds outside the verified interval;
   - no audio before the listening screen is fully faded in, and "Now
     playing" and the clip bar start with the sound.
   node e2e/ladder.mjs --profile=phone|desktop --difficulty=easy|medium [--mix=both] [--log] [--shots=<dir>] */
import fs from "node:fs";
import path from "node:path";
import { serve, open, args, saved } from "./harness.mjs";

const A = args({ profile: "desktop", difficulty: "easy", mix: "both", log: "", shots: "" });
const SEGMENTS = [5, 7, 8];
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
    if (on && !cur){ cur = { el: on, from: on.currentTime, t: now() }; ev("audible", { from: cur.from }); }
    else if (!on && cur){ ending = { ...cur, at: now() }; cur = null; }
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
const fail = m => { throw new Error(m); };
const btn = name => page.getByRole("button", { name });
const fmt = n => n.toFixed(2);
let exit = 0;
try {
  await page.goto(server.url);
  const mix = { bolly: "Hindi", telugu: "Telugu", both: "Both" }[A.mix];
  await page.getByRole("radio", { name: mix, exact: true }).click();
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
  for (const [name, at, label] of [[/^Hear 7s more/, 3000, "rung2"], [/^Hear 8s more/, 0], [/^Replay/, 9000, "replay"]]){
    await btn(name).click();
    await page.getByText(/\ds left/).waitFor({ timeout: 20000 });
    if (at){ await page.waitForTimeout(at); await shot(label); }
    await listened.waitFor({ timeout: 30000 });
  }
  await shot("done");
  await page.waitForTimeout(300);
  const tl = await page.evaluate(() => window.__tl.slice());
  const clips = await page.evaluate(() => window.__ttClips);
  const mode = await page.evaluate(() => window.__ttLastMode);
  const st = await saved(page);
  const track = st.game.queue[st.game.trackIdx];
  const hook = t => (t.duration > 35 ? Math.min(45, Math.max(0, t.duration - 60)) : 0);
  const music = A.difficulty !== "easy";
  if (mode !== (music ? "snip" : "plain")) fail(`played mode ${mode}`);
  const W = music ? track.snip.startSec : hook(track);
  if (music && track.snip.endSec - W !== 20) fail(`snip window is ${track.snip.endSec - W}s, not 20s`);

  // The engine reads media time synchronously when each clip starts playing
  // and right after it pauses; the sampler independently confirms there were
  // exactly four audible stretches and that none escaped the window.
  const heard = tl.filter(e => e.k === "silent").map(e => ({ from: e.from - W, to: e.to - W }));
  const spans = clips.slice(-4).map(c => ({ from: c.from - W, to: c.to - W }));
  const show = list => list.map(s => `[${fmt(s.from)}, ${fmt(s.to)}]`).join(" ");
  console.log(`${A.profile} ${A.difficulty}: window starts at ${fmt(W)}s of "${track.title.slice(0, 30)}"`);
  console.log(`  clip media spans, engine (s into window): ${show(spans)}`);
  console.log(`  audible stretches, sampler (s into window): ${show(heard)}`);
  const expected = [[0, 5], [5, 12], [12, 20], [0, 20]];
  if (heard.length !== expected.length || clips.length !== expected.length)
    fail(`expected ${expected.length} clips, engine ran ${clips.length} and ${heard.length} were heard`);
  expected.forEach(([a, b], i) => {
    if (Math.abs(spans[i].from - a) > TOL || Math.abs(spans[i].to - b) > TOL)
      fail(`play ${i + 1} covered [${fmt(spans[i].from)}, ${fmt(spans[i].to)}], expected [${a}, ${b}]`);
  });
  for (const i of [1, 2]){
    const overlap = spans[i - 1].to - spans[i].from;
    console.log(`  rung ${i} -> ${i + 1} seam: ${overlap >= 0 ? `${fmt(overlap * 1000)}ms repeated` : `${fmt(-overlap * 1000)}ms skipped`}`);
    if (Math.abs(overlap) > 0.08) fail(`rung ${i} -> ${i + 1} seam off by ${fmt(overlap)}s`);
  }
  if (music && heard.concat(spans).some(s => s.from < -0.02 || s.to > 20.1)) fail("music-only sounded outside its verified interval");

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
