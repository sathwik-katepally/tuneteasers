#!/usr/bin/env node
/* Build public/snips.json from current Saavn IDs in the curated corpus.
   scripts/vocal-curve.py separates each recording's vocal stem once with
   htdemucs. The stem's loudness and the mix's loudness are kept as curves in
   scripts/voice-curves.json, so windows of any length come from them without
   fetching the song again. A SNIP_WINDOW_SEC interval is accepted only if
   the vocal stem stays near silent from a lead-in before it to a tail after
   it (gate() below, docs/audio.md).

   Run: node scripts/build-snips.mjs   (CI: .github/workflows/refresh-snips.yml)
   Needs python3 with scripts/requirements-snips.txt, and ffmpeg.
   Env:
     SNIP_CORPUS     corpus.json path override (default public/corpus.json)
     SNIP_PYTHON     python interpreter (default python3)
     SNIP_OUT        output path override (default public/snips.json)
     SNIP_CURVES     curve store (default scripts/voice-curves.json)
     SNIP_LIMIT      score at most N songs (default 300)
     SNIP_BUDGET_MIN stop taking new songs after this many minutes (default
                     300), so a CI job ends cleanly inside its 6h limit
     SNIP_SHARD      "i/n": score only this runner's share of the songs and
                     write a partial index (no size floor) for a later merge
     SNIP_MERGE      directory of shard outputs (snips.json and voice-curves.json
                     each): merge them into SNIP_OUT and SNIP_CURVES without
                     scoring anything; the size floor applies here
     SNIP_PLAN       print only "todo=<n>", the corpus songs still without
                     curves (reads the files, no network), for sizing CI */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { songKey } from "../src/lib/utils.js";
import { SAAVN_BASES, CORPUS_BATCH, SNIP_ACCEPTED, SNIP_VOCAL_MAX_DB, SNIP_INDEX_V, SNIP_METHOD, SNIP_WINDOW_SEC } from "../src/lib/constants.js";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.SNIP_OUT || path.join(REPO, "public/snips.json");
const CURVES = process.env.SNIP_CURVES || path.join(REPO, "scripts/voice-curves.json");
const CORPUS = process.env.SNIP_CORPUS || path.join(REPO, "public/corpus.json");
const PYTHON = process.env.SNIP_PYTHON || "python3";
const LIMIT = Math.max(1, parseInt(process.env.SNIP_LIMIT) || 300);
const BUDGET_MS = Math.max(1, parseFloat(process.env.SNIP_BUDGET_MIN) || 300) * 60e3;
const [SHARD, SHARDS] = (process.env.SNIP_SHARD || "0/1").split("/").map(n => parseInt(n));
const MERGE = process.env.SNIP_MERGE;
const PLAN = !!process.env.SNIP_PLAN;
const MIN_ENTRIES = 80;  // refuse to write a final result thinner than this
const PROGRESS_EVERY = 5;
const SONG_TIMEOUT_MS = 40 * 60e3;

/* The curves that decide windows, one stored series each. Bump a name when
   its model or extraction changes: every song is then scored again, and the
   old curves stay in the store beside the new ones (as MusiCNN's and the v5
   gate's Whisper and RoFormer curves do). */
const CURVE_METHOD = "htdemucs-vocal-db-v1";
const MIX_METHOD = "mix-db-v1";
const LEVEL = "dBFS, loudest 0.1s RMS in each patch";
const DETECTORS = {
  [CURVE_METHOD]: { model: "htdemucs (Demucs v4) vocal stem, whole song", unit: LEVEL },
  [MIX_METHOD]: { model: "the decoded stream itself", unit: LEVEL },
};
const HOP = 0.5, BLOCKS = 5; // curve patches: 0.5s, each the loudest of five 0.1s blocks
const DB = { lo: -100, step: 0.5 };

/* The window gate: the vocal stem stays below SNIP_VOCAL_MAX_DB from LEAD_SEC
   before the window to TAIL_SEC after it. The lead-in keeps a vocal tail out
   of the first seconds; the tail keeps a soft vocal onset out of the last
   ones, which htdemucs registers about two seconds after a listener hears it
   (the October 2026 listening audit, docs/audio.md). The ceiling comes from
   the September 2026 calibration on 262 songs: 99.7% of recognisable singing
   peaked above -51 dBFS. */
const GATE = { LEAD_SEC: 2, TAIL_SEC: 2 };
const CHECKED_METHOD = `${SNIP_METHOD}/${SNIP_VOCAL_MAX_DB}`;

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
  const lang = s => s.language;
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

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e){ return null; } };
const loadIndex = (f = OUT) => {
  const j = readJson(f);
  return j && Object.hasOwn(SNIP_ACCEPTED, j.v) && j.snips && typeof j.snips === "object" ? j : null;
};

/* -- curves: one per song and detector, each self-describing: patch k covers
   [k * hopSec, k * hopSec + patchSec] and holds q[k] (one byte, base64),
   read as lo + q[k] * step, or q[k] / scale for a probability. Every value is
   rounded up, so a stored curve is never quieter or less sure than what was
   measured. MusiCNN's curves (musicnn-voice-dense-v1, p(voice) per ~3s
   patch) keep the same shape. -- */
function loadCurves(file = CURVES){
  const j = readJson(file);
  const ok = j && j.v === 2 && j.songs && typeof j.songs === "object";
  return { detectors: ok && j.detectors ? j.detectors : {}, songs: ok ? j.songs : {} };
}
function writeCurves(store, file = CURVES){
  const ids = Object.keys(store.songs).sort();
  const rows = ids.map(id => `${JSON.stringify(id)}:${JSON.stringify(store.songs[id])}`);
  const head = JSON.stringify({ v:2, detectors:store.detectors });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${head.slice(0, -1)},"songs":{\n${rows.join(",\n")}\n}}\n`);
}
const values = c => {
  const q = Buffer.from(c.q, "base64");
  return Float64Array.from(q, v => (c.scale ? v / c.scale : c.lo + v * c.step));
};
const hasCurves = (store, id) => [CURVE_METHOD, MIX_METHOD].every(m => store.songs[id]?.[m]);

const patches = (blocks, n) => Array.from({ length: n }, (_, k) => Math.max(...blocks.slice(k * BLOCKS, k * BLOCKS + BLOCKS)));
const dbq = v => Math.min(255, Math.max(0, Math.ceil((v - DB.lo) / DB.step)));
const b64 = a => Buffer.from(a).toString("base64");

function addSongCurves(store, id, r){
  const n = Math.floor(r.stem.length / BLOCKS);
  const base = { hopSec:HOP, patchSec:HOP, dur:r.dur };
  Object.assign(store.detectors, DETECTORS);
  store.songs[id] = {
    ...store.songs[id],
    [CURVE_METHOD]: { ...base, ...DB, q: b64(patches(r.stem, n).map(dbq)) },
    [MIX_METHOD]: { ...base, ...DB, q: b64(patches(r.mix, n).map(dbq)) },
  };
}

/* The whole-second windows of `secs` whose stem stays under the ceiling from
   the lead-in to the tail, cleanest first (ties to the earlier start). A tail
   past the end of the recording counts as silent. */
function windows(curves, { secs = SNIP_WINDOW_SEC } = {}){
  const cv = curves?.[CURVE_METHOD];
  if (!cv) return [];
  const level = values(cv), n = level.length, S = cv.hopSec, P = cv.patchSec;
  const span = (a, b) => [Math.max(0, Math.floor((a - P) / S) + 1), Math.min(n - 1, Math.ceil(b / S) - 1)];  // patches overlapping [a, b)
  const list = [];
  for (let t = 0; t + secs + 1 <= Math.floor(cv.dur) && Math.ceil((t + secs) / S) <= n; t++){
    const [k0, k1] = span(t - GATE.LEAD_SEC, t + secs + GATE.TAIL_SEC);
    let m = -Infinity;
    for (let k = k0; k <= k1; k++) if (level[k] > m) m = level[k];
    if (m < SNIP_VOCAL_MAX_DB) list.push({ startSec:t, endSec:t + secs, vocalDb:m, limitDb:SNIP_VOCAL_MAX_DB });
  }
  list.sort((a, b) => a.vocalDb - b.vocalDb || a.startSec - b.startSec);
  return list;
}
const gate = curves => windows(curves)[0] || null;

function writeSnips(v, entries, checked, corpusIds, { final }){
  const keys = Object.keys(entries).sort();
  if (final && keys.length < MIN_ENTRIES){
    console.error(`REFUSING to write ${OUT}: only ${keys.length} entries (< ${MIN_ENTRIES})`);
    process.exit(1);
  }
  const snips = {};
  for (const k of keys) snips[k] = entries[k];
  const rejected = {};
  for (const id of Object.keys(checked).sort()) if (!snips[id]) rejected[id] = checked[id];
  const body = JSON.stringify({ v, built: new Date().toISOString(), snips, checked:rejected, corpusIds:[...corpusIds].sort() });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body + "\n");
  return keys.length;
}

function publish(store, entries, checked, corpusIds, { final, quiet = false }){
  const covered = [...corpusIds].filter(id => hasCurves(store, id)).length;
  const coverage = corpusIds.size ? covered / corpusIds.size : 0;
  const log = quiet ? () => {} : console.log;
  log(`curve coverage: ${covered}/${corpusIds.size} corpus songs (${Math.round(100 * coverage)}%)`);
  const n = writeSnips(SNIP_INDEX_V, entries, checked, corpusIds, { final });
  log(`wrote ${OUT}: v${SNIP_INDEX_V} (${SNIP_METHOD}), ${n} entries`);
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

/* Every corpus song with curves is judged from them on each run. */
function judgeAll(ids, store, entries, checked){
  for (const id of ids){
    if (!hasCurves(store, id)) continue;
    const w = gate(store.songs[id]);
    if (w){ entries[id] = { sourceId:id, ...w, method:SNIP_METHOD }; delete checked[id]; }
    else { delete entries[id]; checked[id] = CHECKED_METHOD; }
  }
}

function merge(){
  const files = fs.readdirSync(MERGE, { recursive: true }).map(f => path.join(MERGE, f));
  const checked = {}, corpusIds = new Set();
  const store = loadCurves();
  const shards = files.filter(f => path.basename(f) === "snips.json");
  for (const f of shards){
    const j = loadIndex(f);
    if (!j) throw new Error(`${f} is not a snips index`);
    for (const id of j.corpusIds || []) corpusIds.add(id);
  }
  // A night with nothing to score has no shards: keep the last run's
  // resolved songs that are still in the corpus.
  const prev = loadIndex();
  if (!shards.length){
    const inCorpus = new Set(loadCorpus().map(s => s.id));
    for (const id of prev?.corpusIds || []) if (inCorpus.has(id)) corpusIds.add(id);
  }
  if (!corpusIds.size) throw new Error("no corpus IDs from shards or the previous index; refusing to prune the curve store");
  for (const f of files.filter(f => path.basename(f) === "voice-curves.json")){
    const c = loadCurves(f);
    Object.assign(store.detectors, c.detectors);
    for (const [id, curves] of Object.entries(c.songs)) store.songs[id] = { ...store.songs[id], ...curves };
  }
  // MusiCNN's curves stay only for songs still in the corpus, like the rest.
  for (const id of Object.keys(store.songs)) if (!corpusIds.has(id)) delete store.songs[id];
  const entries = {};
  judgeAll(corpusIds, store, entries, checked);
  console.log(`merging ${shards.length} shards`);
  publish(store, entries, checked, corpusIds, { final: true });
  writeCurves(store);
  console.log(`${CURVES}: ${Object.keys(store.songs).length} songs with curves`);
  report(entries, checked);
}

function plan(){
  const store = loadCurves();
  console.log(`todo=${loadCorpus().filter(s => s.id && !hasCurves(store, s.id)).length}`);
}

/* One long-lived python process; models load once. Answers come back in
   job order, one line each. */
function startExtractor(){
  const py = spawn(PYTHON, [path.join(REPO, "scripts/vocal-curve.py")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: py.stdout })[Symbol.asyncIterator]();
  let dead = null;
  py.on("exit", code => { dead = `extractor exited (${code})`; });
  const next = async ms => {
    let timer;
    const r = await Promise.race([lines.next(), new Promise(res => { timer = setTimeout(() => res({ timeout: true }), ms); })]);
    clearTimeout(timer);
    if (r.timeout) throw new Error("extractor timed out");
    if (r.done) throw new Error(dead || "extractor closed");
    return JSON.parse(r.value);
  };
  return {
    ready: () => next(30 * 60e3),
    run: async job => { py.stdin.write(JSON.stringify(job) + "\n"); return next(SONG_TIMEOUT_MS); },
    stop: () => { py.stdin.end(); py.kill(); },
  };
}

(async () => {
  if (MERGE) return merge();
  if (PLAN) return plan();
  const t0 = Date.now();
  console.log("resolving corpus songs to streams...");
  const corpus = await collectSongs();
  const perLang = l => corpus.filter(s => s.lang === l).length;
  console.log(`corpus: ${corpus.length} unique songs (${[...new Set(corpus.map(s => s.lang))].map(l => `${perLang(l)} ${l}`).join(", ")})`);
  if (!corpus.length){ console.error("no corpus songs resolved, aborting without touching snips.json"); process.exit(1); }

  const prev = loadIndex();
  const store = loadCurves();
  const corpusIds = new Set(corpus.map(s => s.id));
  const previousIds = new Set(prev?.corpusIds || []);
  const entries = {}, checked = {};
  judgeAll(corpusIds, store, entries, checked);
  const judged = Object.keys(entries).length + Object.keys(checked).length;
  // Only songs without stored curves are fetched; new corpus IDs first.
  const shardOf = id => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SHARDS;
  const todo = corpus.filter(s => !hasCurves(store, s.id) && shardOf(s.id) === SHARD)
    .sort((a,b) => Number(previousIds.has(a.id)) - Number(previousIds.has(b.id)))
    .slice(0, LIMIT);
  console.log(`${judged} judged from stored curves, ${todo.length} to score${SHARDS > 1 ? ` (shard ${SHARD}/${SHARDS})` : ""}`);

  const failures = [];
  let done = 0, kept = 0, sinceWrite = 0, py = null;
  const progress = () => {
    publish(store, entries, checked, corpusIds, { final: false, quiet: true });
    writeCurves(store);
  };
  async function ask(job){
    if (!py){ py = startExtractor(); const r = await py.ready(); console.log(`extractor ready: ${r.separator}`); }
    let r;
    try { r = await py.run(job); }
    catch (e){ py.stop(); py = null; r = { error: e.message }; }
    if (!r.error && r.id !== job.id) r = { error: `answer for ${r.id}` };
    return r;
  }
  async function score(s){
    const t = Date.now();
    const r = await ask({ id:s.id, url:s.stream });
    if (r.error) return `FAIL ${s.title.slice(0, 40)} :: ${r.error.slice(0, 120)}`;
    addSongCurves(store, s.id, r);
    judgeAll([s.id], store, entries, checked);
    const w = entries[s.id];
    if (w) kept++;
    return `${s.lang} ${w ? `vocal=${w.vocalDb}dB start=${w.startSec}s` : "no clean window"}, dur=${Math.round(store.songs[s.id][CURVE_METHOD].dur)}s ${Math.round((Date.now() - t) / 1000)}s  ${s.title.slice(0, 40)}`;
  }

  for (const [pass, list] of [["", todo], ["retry ", null]]){
    const songs = list || failures.splice(0, failures.length);
    if (!list && songs.length) console.log(`\nretrying ${songs.length} failed songs once...`);
    for (const [i, s] of songs.entries()){
      if (Date.now() - t0 > BUDGET_MS){ console.log(`time budget spent; ${songs.length - i} songs left for the next run`); break; }
      const line = await score(s);
      if (list) done++;
      if (line.startsWith("FAIL")) failures.push(s);
      console.log(`${pass}${String(i + 1).padStart(3)}/${songs.length} ${line}`);
      if (++sinceWrite >= PROGRESS_EVERY){ sinceWrite = 0; progress(); }
    }
  }
  if (py) py.stop();

  console.log(`\n${kept} passed of ${done} scored in ${Math.round((Date.now() - t0) / 60000)}min`);
  publish(store, entries, checked, corpusIds, { final: SHARDS === 1 });
  writeCurves(store);
  console.log(`${failures.length} failed after retry`);
  console.log(`${Object.keys(checked).length} source IDs rejected by ${CHECKED_METHOD}`);
  report(entries, checked);
})().catch(e => { console.error("build-snips failed:", e); process.exit(1); });
