#!/usr/bin/env node
/* Build public/snips.json: per-song verified instrumental windows, computed
   offline so the client just seeks and plays (docs/audio.md).

   Pipeline:
   1. Query the Saavn mirror APIs with every SAAVN_QUERIES entry (both
      languages, limit 40) and apply the same filters as the client crate
      (language, year >= 2000, EXCLUDE_RX, https stream), deduped by
      normalized title key.
   2. Score each song not already in snips.json in headless Chromium
      (Playwright) via scripts/snip-harness.html: fetch stream ->
      decodeAudioData -> 16kHz mono render -> MusiCNN p(voice) per ~6s
      patch -> median-of-3 smoothing -> quietest-worst-patch 10s window.
   3. Write { v: 1, built, snips: { key: [startSec, winMax] } } with only
      winMax < 0.40 entries, keys sorted; refuse to write fewer than 80.

   Run: node scripts/build-snips.mjs   (CI: .github/workflows/refresh-snips.yml)
   Env:
     PLAYWRIGHT_DIR  path to a playwright package dir, used when the repo has
                     no playwright devDependency installed
     SNIP_WORKERS    parallel scoring pages (default 3)
     SNIP_OUT        output path override (default public/snips.json)
     SNIP_LIMIT      score at most N songs (smoke tests; final write refuses
                     thin results, so pair with SNIP_OUT) */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.SNIP_OUT || path.join(REPO, "public/snips.json");
const WORKERS = Math.max(1, parseInt(process.env.SNIP_WORKERS) || 3);
const LIMIT = parseInt(process.env.SNIP_LIMIT) || Infinity;
const KEEP_MAX = 0.4;    // entries at or above this winMax are dropped
const MIN_ENTRIES = 80;  // refuse to write a final result thinner than this
const PAGE_RECYCLE = 10; // songs per page before recycling (decode memory)
const PROGRESS_EVERY = 20;

/* -- Saavn corpus (keep queries/filters in sync with src/lib/constants.js
      and the crate's loadFromSaavn; the client and this scorer must agree
      on what a poolable song is) -- */
const SAAVN_BASES = [
  "https://saavn-api.nandanvarma.com/api",
  "https://saavn.dev/api",
];
const SAAVN_QUERIES = {
  bolly: ["bollywood hits","hindi hit songs","Arijit Singh hits","Pritam hits","best of bollywood","hindi songs 2010s","hindi songs 2020s","Shreya Ghoshal hindi","A R Rahman hindi","hindi romantic hits","hindi dance hits","Atif Aslam hits"],
  telugu: ["telugu hits","telugu hit songs","top telugu songs","Sid Sriram telugu","Devi Sri Prasad hits","telugu songs 2010s","telugu songs 2020s","Thaman hits","Anirudh telugu","telugu melody hits","telugu mass hits","tollywood hits"],
};
const EXCLUDE_RX = /(remix|mashup|lo-?fi|slowed|reverb|medley|unplugged|acoustic|cover|karaoke|instrumental|\bbgm\b|jukebox|revisited|reprise|redux|\bclub\b|\bdj\b|mix\b|8d\b|sped up|lounge|\bversion\b)/i;

const stripParens = s => s.replace(/[\(\[].*?[\)\]]/g, "").replace(/\s+/g, " ").trim(); // identical to src/lib/utils.js (keys must match the client's)
const keyOf = title => stripParens(title).toLowerCase();
/* DOM-free version of the client's `de` (textarea entity decode); Saavn
   titles only ever carry the basic named + numeric entities. */
const de = s => String(s || "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sleep = ms => new Promise(r => setTimeout(r, ms));

let saavnBase = null;
async function saavnFetch(p){
  const bases = saavnBase ? [saavnBase] : SAAVN_BASES;
  for (const b of bases){
    try {
      const r = await fetch(b + p, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.data || j.results)){ saavnBase = b; return j; }
    } catch (e){}
  }
  return null;
}
const pickStream = dl => {
  if (!Array.isArray(dl)) return null;
  for (const q of ["96kbps","160kbps","48kbps","320kbps","12kbps"]){
    const hit = dl.find(x => x.quality === q);
    if (hit && (hit.url || hit.link)) return hit.url || hit.link;
  }
  const any = dl.find(x => x.url || x.link);
  return any ? (any.url || any.link) : null;
};
const safeUrl = u => {
  if (typeof u !== "string") return null;
  if (/^https:\/\//i.test(u)) return u;
  if (/^http:\/\//i.test(u)) return "https://" + u.slice(7);
  return null;
};

async function collectSongs(){
  const seen = new Set(), pool = [];
  for (const [lang, queries] of Object.entries(SAAVN_QUERIES)){
    for (const q of queries){
      const r = await saavnFetch(`/search/songs?query=${encodeURIComponent(q)}&limit=40`);
      await sleep(400); // sequential-polite to the mirror API
      const list = r?.data?.results || r?.results || [];
      for (const s of list){
        const name = de(s.name || s.title || "");
        if (!name) continue;
        if ((s.language || "").toLowerCase() !== (lang === "bolly" ? "hindi" : "telugu")) continue;
        if ((parseInt(s.year) || 0) < 2000) continue;
        if (EXCLUDE_RX.test(name)) continue;
        const stream = safeUrl(pickStream(s.downloadUrl));
        if (!stream) continue;
        const key = keyOf(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pool.push({ key, title: name, lang, stream });
      }
    }
  }
  return pool;
}

/* -- existing snips.json: reuse scored entries, carry unseen keys forward
      (a flaky API week must not throw verified windows away) -- */
function loadExisting(){
  try {
    const j = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (j && j.v === 1 && j.snips && typeof j.snips === "object") return { snips: j.snips, built: j.built };
  } catch (e){}
  return { snips: {}, built: null };
}

/* -- local harness server -- */
const ROUTES = {
  "/": [path.join(REPO, "scripts/snip-harness.html"), "text/html"],
  "/vendor/tf.min.js": [path.join(REPO, "node_modules/@tensorflow/tfjs/dist/tf.min.js"), "text/javascript"],
  "/vendor/tf-backend-wasm.min.js": [path.join(REPO, "node_modules/@tensorflow/tfjs-backend-wasm/dist/tf-backend-wasm.min.js"), "text/javascript"],
};
const DIRS = {
  "/tfjs/": path.join(REPO, "scripts/vad-assets/tfjs"),
  "/models/": path.join(REPO, "scripts/vad-assets/models"),
  "/essentia/": path.join(REPO, "node_modules/essentia.js/dist"),
};
const MIME = { ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".bin": "application/octet-stream", ".html": "text/html" };
function serve(req, res){
  const u = req.url.split("?")[0];
  let file = null, type = null;
  if (ROUTES[u]) [file, type] = ROUTES[u];
  else for (const [prefix, dir] of Object.entries(DIRS)){
    if (!u.startsWith(prefix)) continue;
    const f = path.normalize(path.join(dir, u.slice(prefix.length)));
    if (f.startsWith(dir)){ file = f; type = MIME[path.extname(f)] || "application/octet-stream"; }
  }
  if (!file){ res.writeHead(404); res.end(); return; }
  fs.readFile(file, (e, d) => {
    if (e){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": type });
    res.end(d);
  });
}

/* -- playwright: repo devDependency if installed, else PLAYWRIGHT_DIR -- */
function loadPlaywright(){
  const require = createRequire(import.meta.url);
  try { return require("playwright"); } catch (e){}
  if (process.env.PLAYWRIGHT_DIR){
    try { return require(process.env.PLAYWRIGHT_DIR); }
    catch (e){ throw new Error(`PLAYWRIGHT_DIR (${process.env.PLAYWRIGHT_DIR}) did not resolve: ${e.message}`); }
  }
  throw new Error("playwright not found: npm install it or set PLAYWRIGHT_DIR to a playwright package dir");
}

function writeSnips(entries, { final, prev }){
  const keys = Object.keys(entries).sort();
  if (final && keys.length < MIN_ENTRIES){
    console.error(`REFUSING to write ${OUT}: only ${keys.length} entries (< ${MIN_ENTRIES})`);
    process.exit(1);
  }
  const snips = {};
  for (const k of keys) snips[k] = entries[k];
  // an unchanged index keeps its old `built` so the weekly CI commit-if-changed
  // step sees a byte-identical file instead of a timestamp-only diff
  const unchanged = prev && prev.built && JSON.stringify(prev.snips) === JSON.stringify(snips);
  const body = JSON.stringify({ v: 1, built: unchanged ? prev.built : new Date().toISOString(), snips });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body + "\n");
  return keys.length;
}

(async () => {
  const t0 = Date.now();
  console.log("collecting corpus from saavn...");
  const corpus = await collectSongs();
  const perLang = l => corpus.filter(s => s.lang === l).length;
  console.log(`corpus: ${corpus.length} unique songs (${perLang("bolly")} hindi, ${perLang("telugu")} telugu)`);
  if (!corpus.length){ console.error("no songs from saavn, aborting without touching snips.json"); process.exit(1); }

  const prev = loadExisting();
  const existing = prev.snips;
  const entries = { ...existing }; // carry-forward + this run's results
  const todo = corpus.filter(s => !(s.key in existing)).slice(0, LIMIT);
  const reused = corpus.length - corpus.filter(s => !(s.key in existing)).length;
  console.log(`${reused} already scored (reused), ${todo.length} to score`);

  const { chromium } = loadPlaywright();
  const server = http.createServer(serve);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  const failures = [];
  let scored = 0, kept = 0, sinceWrite = 0;

  const newPage = async () => {
    const page = await browser.newPage();
    await page.goto(origin + "/", { waitUntil: "load" });
    await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 60000 });
    await page.evaluate(() => window.__harnessInit());
    return page;
  };

  let next = 0;
  async function worker(id){
    let page = null, used = 0;
    while (true){
      const i = next++;
      if (i >= todo.length) break;
      const s = todo[i];
      if (!page || used >= PAGE_RECYCLE){
        if (page) await page.close().catch(() => {});
        page = await newPage();
        used = 0;
      }
      let r;
      try {
        r = await page.evaluate(u => window.__scoreSong(u), s.stream);
      } catch (e){
        r = { error: String(e && e.message || e).slice(0, 200), stage: "page" };
      }
      used++;
      scored++;
      if (r.error){
        failures.push({ ...s, error: r.error, stage: r.stage });
        console.log(`${String(scored).padStart(3)}/${todo.length} [w${id}] FAIL(${r.stage}) ${s.title.slice(0, 40)} :: ${r.error.slice(0, 80)}`);
        await page.close().catch(() => {}); // a failed job may leave wasm state corrupted
        page = null;
      } else {
        if (r.winMax < KEEP_MAX){ entries[s.key] = [r.startSec, r.winMax]; kept++; }
        console.log(`${String(scored).padStart(3)}/${todo.length} [w${id}] ${s.lang} winMax=${r.winMax.toFixed(3)} start=${r.startSec}s dur=${r.dur}s ${r.ms}ms  ${s.title.slice(0, 40)}`);
      }
      if (++sinceWrite >= PROGRESS_EVERY){
        sinceWrite = 0;
        const n = writeSnips(entries, { final: false, prev });
        console.log(`  ...progress written (${n} entries)`);
      }
      await sleep(250); // polite spacing between stream fetches
    }
    if (page) await page.close().catch(() => {});
  }

  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, (_, i) => worker(i + 1)));

  // one retry pass: transient network/decode hiccups should not cost a song
  if (failures.length){
    console.log(`\nretrying ${failures.length} failed songs once...`);
    const retry = failures.splice(0, failures.length);
    let page = null, used = 0;
    for (const s of retry){
      if (!page || used >= PAGE_RECYCLE){
        if (page) await page.close().catch(() => {});
        page = await newPage();
        used = 0;
      }
      let r;
      try { r = await page.evaluate(u => window.__scoreSong(u), s.stream); }
      catch (e){ r = { error: String(e && e.message || e).slice(0, 200), stage: "page" }; }
      used++;
      if (r.error){
        failures.push({ ...s, error: r.error, stage: r.stage });
        console.log(`  still failing (${r.stage}): ${s.title.slice(0, 40)} :: ${r.error.slice(0, 80)}`);
        await page.close().catch(() => {});
        page = null;
      } else {
        if (r.winMax < KEEP_MAX){ entries[s.key] = [r.startSec, r.winMax]; kept++; }
        console.log(`  retry ok: winMax=${r.winMax.toFixed(3)} ${s.title.slice(0, 40)}`);
      }
      await sleep(250);
    }
    if (page) await page.close().catch(() => {});
  }

  await browser.close();
  server.close();

  const n = writeSnips(entries, { final: true, prev });
  const wins = Object.values(entries).map(e => e[1]);
  const under = t => wins.filter(w => w < t).length;
  console.log(`\nwrote ${OUT}: ${n} entries (${kept} new this run) in ${Math.round((Date.now() - t0) / 60000)}min`);
  console.log(`winMax: <0.25 ${under(0.25)} | <0.30 ${under(0.3)} | <0.35 ${under(0.35)} | <0.40 ${under(0.4)}`);
  console.log(`scored ${scored} songs, ${failures.length} failed after retry (${scored ? Math.round(100 * failures.length / scored) : 0}%)`);
  for (const f of failures) console.log(`  FAILED ${f.lang} ${f.title.slice(0, 44)} (${f.stage}) ${f.error.slice(0, 90)}`);
})().catch(e => { console.error("build-snips failed:", e); process.exit(1); });
