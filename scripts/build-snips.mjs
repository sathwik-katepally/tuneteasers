#!/usr/bin/env node
/* Build public/snips.json from current Saavn IDs in the curated corpus.
   Headless Chromium decodes each recording once and scores overlapping
   MusiCNN patches (~3s every ~1s) across the whole song. That voice curve is
   kept in scripts/voice-curves.json, so windows of any length come from it
   without fetching the song again. A SNIP_WINDOW_SEC interval is accepted
   only if every patch overlapping it scores below the clean threshold.

   Run: node scripts/build-snips.mjs   (CI: .github/workflows/refresh-snips.yml)
   Env:
     SNIP_CORPUS     corpus.json path override (default public/corpus.json)
     PLAYWRIGHT_DIR  path to a playwright package dir, used when the repo has
                     no playwright devDependency installed
     SNIP_WORKERS    parallel scoring pages (default 3)
     SNIP_OUT        output path override (default public/snips.json)
     SNIP_CURVES     voice curve store (default scripts/voice-curves.json)
     SNIP_PRIOR      an index of an earlier schema whose verified windows at
                     least SNIP_WINDOW_SEC long carry over without scoring;
                     defaults to the output file while it holds an older schema
     SNIP_LIMIT      score at most N songs (default 300 per scheduled run)
     SNIP_SHARD      "i/n": score only this runner's share of the songs and
                     write a partial index (no size floor) for a later merge
     SNIP_MERGE      directory of shard outputs (snips.json and voice-curves.json
                     each): merge them into SNIP_OUT and SNIP_CURVES without
                     scoring anything; the size floor applies here */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { songKey } from "../src/lib/utils.js";
import { SAAVN_BASES, CORPUS_BATCH, SNIP_CLEAN_MAX, SNIP_INDEX_V, SNIP_METHOD, SNIP_WINDOW_SEC } from "../src/lib/constants.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.SNIP_OUT || path.join(REPO, "public/snips.json");
const CURVES = process.env.SNIP_CURVES || path.join(REPO, "scripts/voice-curves.json");
const CORPUS = process.env.SNIP_CORPUS || path.join(REPO, "public/corpus.json");
const WORKERS = Math.max(1, parseInt(process.env.SNIP_WORKERS) || 3);
const LIMIT = Math.max(1, parseInt(process.env.SNIP_LIMIT) || 300);
const [SHARD, SHARDS] = (process.env.SNIP_SHARD || "0/1").split("/").map(n => parseInt(n));
const MERGE = process.env.SNIP_MERGE;
const MIN_ENTRIES = 80;  // refuse to write a final result thinner than this
const CHECKED_METHOD = `${SNIP_METHOD}/${SNIP_CLEAN_MAX}`;
const PAGE_RECYCLE = 10; // songs per page before recycling (decode memory)
const PROGRESS_EVERY = 20;
// Bump when the model, patch geometry or extraction changes: stored curves
// of another method are thrown away and every song is scored again.
const CURVE_METHOD = "musicnn-voice-dense-v1";
const CURVE_SCALE = 255;
// Earlier schemas whose windows passed the same every-patch check, so any
// stretch of one is clean too.
const CARRY_METHODS = new Set(["continuous-v3"]);

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
   earlier schema only lends its verified windows that are long enough -- */
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e){ return null; } };
function loadExisting(){
  const j = readJson(OUT);
  const current = j && j.v === SNIP_INDEX_V && j.snips && typeof j.snips === "object";
  const prior = process.env.SNIP_PRIOR ? readJson(process.env.SNIP_PRIOR) : current ? null : j;
  const priorSnips = prior && Number.isInteger(prior.v) && prior.v < SNIP_INDEX_V && prior.snips && typeof prior.snips === "object" ? prior.snips : {};
  return { snips: current ? j.snips : {}, checked: current ? j.checked || {} : {}, corpusIds: Array.isArray(j?.corpusIds) ? j.corpusIds : [], priorSnips };
}
function carriedWindow(id, e){
  if (!e || e.sourceId !== id || !CARRY_METHODS.has(e.method) || !Number.isInteger(e.startSec) || e.startSec < 0 ||
      !(e.endSec - e.startSec >= SNIP_WINDOW_SEC) || !(e.maxVoice < SNIP_CLEAN_MAX)) return null;
  return { sourceId:id, startSec:e.startSec, endSec:e.startSec + SNIP_WINDOW_SEC, maxVoice:e.maxVoice, method:SNIP_METHOD };
}

/* -- voice curves: p(voice) per patch, one byte each, rounded up so a
   window judged from the stored curve is never cleaner than the model said.
   Patch k covers [k * strideSec, k * strideSec + patchSec]. -- */
function loadCurves(file = CURVES){
  const j = readJson(file);
  if (!j || j.v !== 1 || j.method !== CURVE_METHOD || !j.songs || typeof j.songs !== "object")
    return { strideSec:null, patchSec:null, songs:{} };
  return { strideSec:j.strideSec, patchSec:j.patchSec, songs:j.songs };
}
function writeCurves(store, file = CURVES){
  const ids = Object.keys(store.songs).sort();
  const rows = ids.map(id => `${JSON.stringify(id)}:${JSON.stringify(store.songs[id])}`);
  const head = JSON.stringify({ v:1, method:CURVE_METHOD, strideSec:store.strideSec, patchSec:store.patchSec, scale:CURVE_SCALE });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.slice(0, -1)},"songs":{\n${rows.join(",\n")}\n}}\n`);
}
const encodeCurve = probs => Buffer.from(probs.map(p => Math.min(CURVE_SCALE, Math.max(0, Math.ceil(p * CURVE_SCALE))))).toString("base64");

/* The cleanest whole-second window of `secs` in a stored curve. A window is
   judged by the chain of overlapping patches that covers it end to end, from
   the last patch starting at or before it to the first reaching its end, and
   every one must score below SNIP_CLEAN_MAX. Ties go to the earlier start. */
function windowFromCurve(song, store, secs = SNIP_WINDOW_SEC){
  const q = Buffer.from(song.q, "base64"), S = store.strideSec, P = store.patchSec;
  if (!q.length || !(S > 0) || !(P > 0) || !(S < P)) return null;
  let best = null;
  for (let t = 0; t <= Math.floor(song.dur) - secs - 1; t++){
    // Rounding can only widen the chain.
    const k0 = Math.floor(t / S), k1 = Math.ceil((t + secs - P) / S);
    if (k1 >= q.length) break;
    let m = 0;
    for (let k = k0; k <= k1; k++) if (q[k] > m) m = q[k];
    if (!best || m < best.m) best = { t, m };
  }
  if (!best || !(best.m / CURVE_SCALE < SNIP_CLEAN_MAX)) return null;
  return { startSec:best.t, endSec:best.t + secs, maxVoice:Math.ceil(best.m / CURVE_SCALE * 1000) / 1000 };
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
  const files = fs.readdirSync(MERGE, { recursive: true }).map(f => path.join(MERGE, f));
  const entries = {}, checked = {}, corpusIds = new Set();
  const store = loadCurves();
  const shards = files.filter(f => path.basename(f) === "snips.json");
  for (const f of shards){
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (j?.v !== SNIP_INDEX_V) throw new Error(`${f} is not a v${SNIP_INDEX_V} shard`);
    Object.assign(entries, j.snips);
    Object.assign(checked, j.checked);
    for (const id of j.corpusIds || []) corpusIds.add(id);
  }
  for (const f of files.filter(f => path.basename(f) === "voice-curves.json")){
    const c = loadCurves(f);
    if (!c.strideSec) continue;
    if (store.strideSec && (store.strideSec !== c.strideSec || store.patchSec !== c.patchSec)) throw new Error(`${f} has another patch geometry`);
    store.strideSec = c.strideSec; store.patchSec = c.patchSec;
    Object.assign(store.songs, c.songs);
  }
  for (const id of Object.keys(entries)) if (!corpusIds.has(id)) delete entries[id];
  for (const id of Object.keys(store.songs)) if (!corpusIds.has(id)) delete store.songs[id];
  console.log(`merging ${shards.length} shards`);
  const n = writeSnips(entries, checked, corpusIds, { final: true });
  writeCurves(store);
  console.log(`wrote ${OUT}: ${n} entries; ${CURVES}: ${Object.keys(store.songs).length} curves`);
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
  const store = loadCurves();
  const corpusIds = new Set(corpus.map(s => s.id));
  const previousIds = new Set(prev.corpusIds);
  const entries = Object.fromEntries(Object.entries(prev.snips).filter(([id, e]) =>
    corpusIds.has(id) && e.sourceId === id && e.method === SNIP_METHOD &&
    Number.isInteger(e.startSec) && e.startSec >= 0 && e.endSec - e.startSec === SNIP_WINDOW_SEC &&
    Number.isFinite(e.maxVoice) && e.maxVoice < SNIP_CLEAN_MAX));
  const checked = Object.fromEntries(Object.entries(prev.checked).filter(([id, method]) =>
    corpusIds.has(id) && method === CHECKED_METHOD));
  const reused = Object.keys(entries).length;
  let carried = 0, derived = 0;
  for (const s of corpus){
    if (entries[s.id]) continue;
    const w = carriedWindow(s.id, prev.priorSnips[s.id]);
    if (w){ entries[s.id] = w; carried++; }
  }
  const judge = s => {
    const w = windowFromCurve(store.songs[s.id], store);
    if (w){ entries[s.id] = { sourceId:s.id, ...w, method:SNIP_METHOD }; delete checked[s.id]; }
    else checked[s.id] = CHECKED_METHOD;
    return w;
  };
  for (const s of corpus) if (!entries[s.id] && store.songs[s.id]){ judge(s); derived++; }
  // Only songs with neither a window nor a stored curve are fetched; new corpus IDs first.
  const shardOf = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SHARDS;
  const todo = corpus.filter(s => !entries[s.id] && !store.songs[s.id] && shardOf(s.id) === SHARD)
    .sort((a,b) => Number(previousIds.has(a.id)) - Number(previousIds.has(b.id)))
    .slice(0, LIMIT);
  console.log(`${reused} reused, ${carried} carried over from the earlier schema, ${derived} judged from stored curves, ${todo.length} to score${SHARDS > 1 ? ` (shard ${SHARD}/${SHARDS})` : ""}`);

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
  /* Scores one song on `page`; returns a log line, or null after a failure
     (the caller drops the page: a failed job may leave wasm state corrupted). */
  async function score(page, s){
    let r;
    try { r = await page.evaluate(u => window.__scoreCurve(u), s.stream); }
    catch (e){ r = { error: String(e && e.message || e).slice(0, 200), stage: "page" }; }
    if (r.error){ failures.push({ ...s, error: r.error, stage: r.stage }); return null; }
    if (store.strideSec && (store.strideSec !== r.strideSec || store.patchSec !== r.patchSec))
      throw new Error("harness patch geometry differs from the stored curves; bump CURVE_METHOD");
    store.strideSec = r.strideSec; store.patchSec = r.patchSec;
    store.songs[s.id] = { dur: Math.round(r.dur * 100) / 100, q: encodeCurve(r.curve) };
    const w = judge(s);
    if (w) kept++;
    return `${s.lang} ${w ? `maxVoice=${w.maxVoice.toFixed(3)} start=${w.startSec}s` : "no clean window"} patches=${r.curve.length} dur=${Math.round(r.dur)}s ${r.ms}ms  ${s.title.slice(0, 40)}`;
  }
  const progress = () => {
    const n = writeSnips(entries, checked, corpusIds, { final: false });
    writeCurves(store);
    console.log(`  ...progress written (${n} entries)`);
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
      used++;
      const line = await score(page, s);
      scored++;
      if (line) console.log(`${String(scored).padStart(3)}/${todo.length} [w${id}] ${line}`);
      else {
        const f = failures[failures.length - 1];
        console.log(`${String(scored).padStart(3)}/${todo.length} [w${id}] FAIL(${f.stage}) ${s.title.slice(0, 40)} :: ${f.error.slice(0, 80)}`);
        await page.close().catch(() => {});
        page = null;
      }
      if (++sinceWrite >= PROGRESS_EVERY){ sinceWrite = 0; progress(); }
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
      used++;
      const line = await score(page, s);
      if (line) console.log(`  retry ok: ${line}`);
      else {
        const f = failures[failures.length - 1];
        console.log(`  still failing (${f.stage}): ${s.title.slice(0, 40)} :: ${f.error.slice(0, 80)}`);
        await page.close().catch(() => {});
        page = null;
      }
      await sleep(250);
    }
    if (page) await page.close().catch(() => {});
  }

  await browser.close();
  server.close();

  const n = writeSnips(entries, checked, corpusIds, { final: SHARDS === 1 });
  writeCurves(store);
  console.log(`\nwrote ${OUT}: ${n} entries (${kept} new from ${scored} scored) in ${Math.round((Date.now() - t0) / 60000)}min`);
  console.log(`${Object.keys(store.songs).length} voice curves in ${CURVES}`);
  console.log(`${failures.length} failed after retry (${scored ? Math.round(100 * failures.length / scored) : 0}%)`);
  console.log(`${Object.keys(checked).length} source IDs rejected by ${CHECKED_METHOD}`);
  for (const f of failures) console.log(`  FAILED ${f.lang} ${f.title.slice(0, 44)} (${f.stage}) ${f.error.slice(0, 90)}`);
  report(entries, checked);
})().catch(e => { console.error("build-snips failed:", e); process.exit(1); });
