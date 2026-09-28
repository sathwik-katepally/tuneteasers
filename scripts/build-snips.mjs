#!/usr/bin/env node
/* Build public/snips.json from current Saavn IDs in the curated corpus.
   Headless Chromium decodes each recording, uses old offsets only as
   candidates, and accepts a SNIP_WINDOW_SEC interval only after overlapping
   MusiCNN patches cover it continuously below the clean threshold.

   Run: node scripts/build-snips.mjs   (CI: .github/workflows/refresh-snips.yml)
   Env:
     SNIP_CORPUS     corpus.json path override (default public/corpus.json)
     PLAYWRIGHT_DIR  path to a playwright package dir, used when the repo has
                     no playwright devDependency installed
     SNIP_WORKERS    parallel scoring pages (default 3)
     SNIP_OUT        output path override (default public/snips.json)
     SNIP_HINTS      an index of an earlier schema whose starts seed the search;
                     defaults to the output file while it holds an older schema
     SNIP_LIMIT      score at most N songs (default 300 per scheduled run)
     SNIP_SHARD      "i/n": score only this runner's share of the songs and
                     write a partial index (no size floor) for a later merge
     SNIP_MERGE      directory of shard outputs: merge them into SNIP_OUT
                     without scoring anything; the size floor applies here */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { songKey } from "../src/lib/utils.js";
import { SAAVN_BASES, CORPUS_BATCH, SNIP_CLEAN_MAX, SNIP_INDEX_V, SNIP_METHOD, SNIP_WINDOW_SEC } from "../src/lib/constants.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.SNIP_OUT || path.join(REPO, "public/snips.json");
const CORPUS = process.env.SNIP_CORPUS || path.join(REPO, "public/corpus.json");
const WORKERS = Math.max(1, parseInt(process.env.SNIP_WORKERS) || 3);
const LIMIT = Math.max(1, parseInt(process.env.SNIP_LIMIT) || 300);
const [SHARD, SHARDS] = (process.env.SNIP_SHARD || "0/1").split("/").map(n => parseInt(n));
const MERGE = process.env.SNIP_MERGE;
const MIN_ENTRIES = 80;  // refuse to write a final result thinner than this
const CHECKED_METHOD = `${SNIP_METHOD}/${SNIP_CLEAN_MAX}`;
const PAGE_RECYCLE = 10; // songs per page before recycling (decode memory)
const PROGRESS_EVERY = 20;

/* -- corpus songs -> stream URLs (the same batch endpoint the client uses) -- */
const keyOf = songKey;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let saavnBase = null, lastFetchError = "unknown";
async function saavnFetch(p){
  for (let attempt = 0; attempt < 3; attempt++){
    const bases = saavnBase ? [saavnBase, ...SAAVN_BASES.filter(b => b !== saavnBase)] : SAAVN_BASES;
    for (const b of bases){
      try {
        const r = await fetch(b + p, { signal: AbortSignal.timeout(15000) });
        if (!r.ok){ lastFetchError = `${new URL(b).host}: HTTP ${r.status}`; continue; }
        const j = await r.json();
        if (Array.isArray(j?.data) && j.data.length){ saavnBase = b; return j; }
        lastFetchError = `${new URL(b).host}: empty or invalid songs response`;
      } catch (e){ lastFetchError = `${new URL(b).host}: ${e?.name || "fetch error"}`; }
    }
    if (attempt < 2) await sleep(1000 * (attempt + 1));
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

function loadCorpus(){
  const j = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
  if (!j || j.v !== 1 || !Array.isArray(j.cols) || !Array.isArray(j.songs)) throw new Error(`${CORPUS} is not a v1 corpus`);
  return j.songs.map(row => Object.fromEntries(j.cols.map((c, i) => [c, row[i]])));
}

async function collectSongs(){
  const corpus = loadCorpus();
  const lang = s => (s.language === "telugu" ? "telugu" : "bolly");
  const seen = new Set(), pool = [], unresolved = [];
  let consecutiveEmpty = 0;
  for (let i = 0; i < corpus.length; i += CORPUS_BATCH){
    const batch = corpus.slice(i, i + CORPUS_BATCH);
    const r = await saavnFetch(`/songs?ids=${batch.map(s => s.id).join(",")}`);
    consecutiveEmpty = r?.data?.length ? 0 : consecutiveEmpty + 1;
    if (consecutiveEmpty >= 3)
      throw new Error(`three consecutive corpus batches returned no songs; last endpoint result: ${lastFetchError}`);
    await sleep(300); // sequential-polite to the API
    const byId = new Map((Array.isArray(r?.data) ? r.data : []).map(x => [x.id, x]));
    for (const s of batch){
      const key = keyOf(s.title);
      if (!key || !s.id || seen.has(s.id)) continue;
      const stream = safeUrl(pickStream(byId.get(s.id)?.downloadUrl));
      if (!stream){ unresolved.push(s); continue; }
      seen.add(s.id);
      pool.push({ id:s.id, key, title: s.title, lang: lang(s), stream });
    }
  }
  if (unresolved.length) console.log(`${unresolved.length} corpus songs did not resolve to a stream`);
  return pool;
}

/* -- reuse only source-bound entries of the current schema; an index of an
   earlier schema (another window length) only seeds candidate starts per ID -- */
function priorHints(j){
  const hints = {};
  if (j && Number.isInteger(j.v) && j.v < SNIP_INDEX_V && j.snips && typeof j.snips === "object")
    for (const [id, e] of Object.entries(j.snips)) if (e?.sourceId === id && Number.isFinite(e.startSec)) hints[id] = e.startSec;
  return hints;
}
function loadExisting(){
  let j = null;
  try { j = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (e){}
  let hints = priorHints(j);
  if (process.env.SNIP_HINTS) hints = priorHints(JSON.parse(fs.readFileSync(process.env.SNIP_HINTS, "utf8")));
  const current = j && j.v === SNIP_INDEX_V && j.snips && typeof j.snips === "object";
  return { snips: current ? j.snips : {}, checked: current ? j.checked || {} : {}, corpusIds: Array.isArray(j?.corpusIds) ? j.corpusIds : [], hints };
}

/* -- local harness server -- */
const ROUTES = {
  "/": [path.join(REPO, "scripts/snip-harness.html"), "text/html"],
  "/constants.js": [path.join(REPO, "src/lib/constants.js"), "text/javascript"],
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

function writeSnips(entries, checked, corpusIds, { final }){
  const keys = Object.keys(entries).sort();
  if (final && keys.length < MIN_ENTRIES){
    console.error(`REFUSING to write ${OUT}: only ${keys.length} entries (< ${MIN_ENTRIES})`);
    process.exit(1);
  }
  const snips = {};
  for (const k of keys) snips[k] = entries[k];
  const rejected = {};
  for (const id of Object.keys(checked).sort()) if (!snips[id]) rejected[id] = checked[id];
  const body = JSON.stringify({ v: SNIP_INDEX_V, built: new Date().toISOString(), snips, checked:rejected, corpusIds:[...corpusIds].sort() });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body + "\n");
  return keys.length;
}

/* Kept entries per language and corpus tier, and the share of scored
   recordings that passed; the numbers that decide whether Music-only games
   can start. */
function report(entries, checked){
  const tierOf = new Map(loadCorpus().map(s => [s.id, `${s.language}/${s.tier}`]));
  const cells = {};
  for (const id of Object.keys(entries)){ const k = tierOf.get(id) || "unknown"; cells[k] = (cells[k] || 0) + 1; }
  const kept = Object.keys(entries).length, rejected = Object.keys(checked).filter(id => !entries[id]).length;
  console.log(`pass rate: ${kept}/${kept + rejected} scored recordings (${kept + rejected ? Math.round(100 * kept / (kept + rejected)) : 0}%)`);
  console.log(`entries by language/tier: ${Object.entries(cells).sort().map(([k, n]) => `${k}=${n}`).join(" ")}`);
}

function merge(){
  const files = fs.readdirSync(MERGE, { recursive: true }).filter(f => f.endsWith(".json")).map(f => path.join(MERGE, f));
  const entries = {}, checked = {}, corpusIds = new Set();
  for (const f of files){
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j?.v !== SNIP_INDEX_V) throw new Error(`${f} is not a v${SNIP_INDEX_V} shard`);
    Object.assign(entries, j.snips);
    Object.assign(checked, j.checked);
    for (const id of j.corpusIds || []) corpusIds.add(id);
  }
  for (const id of Object.keys(entries)) if (!corpusIds.has(id)) delete entries[id];
  console.log(`merging ${files.length} shards`);
  const n = writeSnips(entries, checked, corpusIds, { final: true });
  console.log(`wrote ${OUT}: ${n} entries`);
  report(entries, checked);
}

(async () => {
  if (MERGE) return merge();
  const t0 = Date.now();
  console.log("resolving corpus songs to streams...");
  const corpus = await collectSongs();
  const perLang = l => corpus.filter(s => s.lang === l).length;
  console.log(`corpus: ${corpus.length} unique songs (${perLang("bolly")} hindi, ${perLang("telugu")} telugu)`);
  if (!corpus.length){ console.error("no corpus songs resolved, aborting without touching snips.json"); process.exit(1); }

  const prev = loadExisting();
  const existing = prev.snips;
  const corpusIds = new Set(corpus.map(s => s.id));
  const previousIds = new Set(prev.corpusIds);
  const entries = Object.fromEntries(Object.entries(existing).filter(([id, e]) =>
    corpusIds.has(id) && e.sourceId === id && e.method === SNIP_METHOD &&
    Number.isInteger(e.startSec) && e.startSec >= 0 && e.endSec - e.startSec === SNIP_WINDOW_SEC &&
    Number.isFinite(e.maxVoice) && e.maxVoice < SNIP_CLEAN_MAX));
  const checked = Object.fromEntries(Object.entries(prev.checked).filter(([id, method]) =>
    corpusIds.has(id) && method === CHECKED_METHOD));
  const hintOf = s => (Number.isFinite(prev.hints[s.id]) ? prev.hints[s.id] : null);
  // New corpus IDs first, then recordings that had a clean window in an earlier schema.
  const shardOf = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SHARDS;
  const todo = corpus.filter(s => !(s.id in entries) && checked[s.id] !== CHECKED_METHOD && shardOf(s.id) === SHARD)
    .sort((a,b) => Number(previousIds.has(a.id)) - Number(previousIds.has(b.id)) || Number(hintOf(a) === null) - Number(hintOf(b) === null))
    .slice(0, LIMIT);
  const reused = Object.keys(entries).length;
  console.log(`${reused} already scored (reused), ${todo.length} to score${SHARDS > 1 ? ` (shard ${SHARD}/${SHARDS})` : ""}`);

  const { chromium } = loadPlaywright();
  const server = http.createServer(serve);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ["--mute-audio"] });

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
        r = await page.evaluate(({u,h}) => window.__scoreSong(u,h), {u:s.stream,h:hintOf(s)});
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
        if (r.maxVoice < SNIP_CLEAN_MAX && Number.isFinite(r.startSec)){
          entries[s.id] = { sourceId:s.id, startSec:r.startSec, endSec:r.endSec, maxVoice:r.maxVoice, method:SNIP_METHOD }; kept++;
        } else checked[s.id] = CHECKED_METHOD;
        console.log(`${String(scored).padStart(3)}/${todo.length} [w${id}] ${s.lang} maxVoice=${r.maxVoice.toFixed(3)} start=${r.startSec ?? "none"}s dur=${r.dur}s regions=${r.regions} ${r.ms}ms  ${s.title.slice(0, 40)}`);
      }
      if (++sinceWrite >= PROGRESS_EVERY){
        sinceWrite = 0;
        const n = writeSnips(entries, checked, corpusIds, { final: false });
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
      try { r = await page.evaluate(({u,h}) => window.__scoreSong(u,h), {u:s.stream,h:hintOf(s)}); }
      catch (e){ r = { error: String(e && e.message || e).slice(0, 200), stage: "page" }; }
      used++;
      if (r.error){
        failures.push({ ...s, error: r.error, stage: r.stage });
        console.log(`  still failing (${r.stage}): ${s.title.slice(0, 40)} :: ${r.error.slice(0, 80)}`);
        await page.close().catch(() => {});
        page = null;
      } else {
        if (r.maxVoice < SNIP_CLEAN_MAX && Number.isFinite(r.startSec)){
          entries[s.id] = { sourceId:s.id, startSec:r.startSec, endSec:r.endSec, maxVoice:r.maxVoice, method:SNIP_METHOD }; kept++;
        } else checked[s.id] = CHECKED_METHOD;
        console.log(`  retry ok: maxVoice=${r.maxVoice.toFixed(3)} ${s.title.slice(0, 40)}`);
      }
      await sleep(250);
    }
    if (page) await page.close().catch(() => {});
  }

  await browser.close();
  server.close();

  const n = writeSnips(entries, checked, corpusIds, { final: SHARDS === 1 });
  const wins = Object.values(entries).map(e => e.maxVoice);
  const under = t => wins.filter(w => w < t).length;
  console.log(`\nwrote ${OUT}: ${n} entries (${kept} new this run) in ${Math.round((Date.now() - t0) / 60000)}min`);
  console.log(`winMax: <0.25 ${under(0.25)} | <0.30 ${under(0.3)} | <0.35 ${under(0.35)} | <0.40 ${under(0.4)}`);
  console.log(`scored ${scored} songs, ${failures.length} failed after retry (${scored ? Math.round(100 * failures.length / scored) : 0}%)`);
  console.log(`${Object.keys(checked).length} source IDs rejected by ${CHECKED_METHOD}`);
  for (const f of failures) console.log(`  FAILED ${f.lang} ${f.title.slice(0, 44)} (${f.stage}) ${f.error.slice(0, 90)}`);
  report(entries, checked);
})().catch(e => { console.error("build-snips failed:", e); process.exit(1); });
