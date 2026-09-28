#!/usr/bin/env node
/* Build public/snips.json from current Saavn IDs in the curated corpus.
   scripts/vocal-curve.py separates each recording's vocal stem once with
   htdemucs and transcribes it with Whisper. The stem's loudness, the mix's
   loudness and the recognised words are kept as curves in
   scripts/voice-curves.json, so windows of any length come from them without
   fetching the song again. The best candidate windows are then separated
   again with Mel-Band RoFormer, and a SNIP_WINDOW_SEC interval is accepted
   only if both vocal stems stay near silent from a lead-in before it to its
   end and Whisper heard no word near it in either (gate() below,
   docs/audio.md).

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
                     curves (reads the files, no network), for sizing CI

   Until curves cover SWITCH_COVERAGE of the corpus, the index it publishes
   is still MusiCNN's v4 one, carried over with a fresh build time; from then
   on it publishes the v5 index judged from the curves, and stays on it. */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { songKey } from "../src/lib/utils.js";
import { SAAVN_BASES, CORPUS_BATCH, SNIP_ACCEPTED, SNIP_LEGACY, SNIP_VOCAL_MAX_DB, SNIP_INDEX_V, SNIP_METHOD, SNIP_WINDOW_SEC } from "../src/lib/constants.js";

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
const SWITCH_COVERAGE = 0.95;
const MIN_ENTRIES = 80;  // refuse to write a final result thinner than this
const PROGRESS_EVERY = 5;
const SONG_TIMEOUT_MS = 40 * 60e3;

/* The curves that decide windows, one stored series each. Bump a name when
   its model or extraction changes: every song is then scored again, and the
   old curves stay in the store beside the new ones (as MusiCNN's do).
   The RoFormer curves are partial: only the candidate windows it was asked
   to confirm are measured, and every other patch holds the byte 255 (+27.5
   dBFS), so an unmeasured stretch can never pass. */
const CURVE_METHOD = "htdemucs-vocal-db-v1";
const WORDS_METHOD = "htdemucs-whisper-turbo-words-v1";
const MIX_METHOD = "mix-db-v1";
const CONFIRM_METHOD = "melband-kim-vocal-db-v1";
const CONFIRM_WORDS = "melband-kim-whisper-turbo-words-v1";
const LEVEL = "dBFS, loudest 0.1s RMS in each patch";
const WORDS = "highest probability of a word Whisper large-v3-turbo (faster-whisper, int8) recognised in the stem, over the patch";
const DETECTORS = {
  [CURVE_METHOD]: { model: "htdemucs (Demucs v4) vocal stem, whole song", unit: LEVEL },
  [WORDS_METHOD]: { model: "Whisper on the htdemucs vocal stem, whole song", unit: WORDS },
  [MIX_METHOD]: { model: "the decoded stream itself", unit: LEVEL },
  [CONFIRM_METHOD]: { model: "Mel-Band RoFormer vocals (Kimberley Jensen, audio-separator) on candidate windows only; 255 = not measured", unit: LEVEL },
  [CONFIRM_WORDS]: { model: "Whisper on the Mel-Band RoFormer vocal stem of the same candidate windows", unit: WORDS },
};
const HOP = 0.5, BLOCKS = 5; // curve patches: 0.5s, each the loudest of five 0.1s blocks
const DB = { lo: -100, step: 0.5 };
const UNMEASURED = 255;

/* The window gate. The numbers come from the September 2026 calibration on
   262 songs (docs/audio.md), and the merge prints them again from the whole
   corpus on every run (calibration()):
   - both vocal stems stay below the song's limit from LEAD_SEC before the
     window to its end. The limit is min(SNIP_VOCAL_MAX_DB, the song's own
     singing level - SONG_DROP_DB); the singing level is the median htdemucs
     stem level over patches holding a word Whisper is sure of (SURE_P), when
     the song has at least SURE_WORDS of them. 99.7% of the loudest patches of
     such sure words sat above -51 dBFS and within 38 dB of their song's level.
   - Whisper recognised no word (WORD_P) within WORD_PAD_SEC of that span in
     either stem. A word only counts where its stem is at least WORD_FLOOR_DB:
     over a silent stem Whisper invents words (mostly "झाल"), and a separator
     that missed a voice is the other separator's job to catch.
   Each song gets up to CONFIRMS RoFormer checks, cleanest candidate first. */
const GATE = { LEAD_SEC: 2, SONG_DROP_DB: 38, WORD_P: 0.5, WORD_PAD_SEC: 1, WORD_FLOOR_DB: -60, SURE_P: 0.8, SURE_WORDS: 10, CONFIRMS: 3 };
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
const scored = (store, id) => [CURVE_METHOD, WORDS_METHOD, MIX_METHOD].every(m => store.songs[id]?.[m]);
const hasCurves = (store, id) => scored(store, id) && !!store.songs[id][CONFIRM_METHOD];

const patches = (blocks, n) => Array.from({ length: n }, (_, k) => Math.max(...blocks.slice(k * BLOCKS, k * BLOCKS + BLOCKS)));
const dbq = v => Math.min(255, Math.max(0, Math.ceil((v - DB.lo) / DB.step)));
const pq = p => Math.min(255, Math.ceil(p * 255));
const b64 = a => Buffer.from(a).toString("base64");
function wordPatches(words, n, from = 0){
  const w = new Array(n).fill(0);
  for (const [a, b, p] of words)
    for (let k = Math.max(0, Math.floor(a / HOP)); k < n && k * HOP < b; k++) if (k * HOP >= from) w[k] = Math.max(w[k], p);
  return w;
}

function addSongCurves(store, id, r){
  const n = Math.floor(r.stem.length / BLOCKS);
  const base = { hopSec:HOP, patchSec:HOP, dur:r.dur };
  Object.assign(store.detectors, DETECTORS);
  store.songs[id] = {
    ...store.songs[id],
    [CURVE_METHOD]: { ...base, ...DB, q: b64(patches(r.stem, n).map(dbq)) },
    [WORDS_METHOD]: { ...base, scale:255, q: b64(wordPatches(r.words, n).map(pq)) },
    [MIX_METHOD]: { ...base, ...DB, q: b64(patches(r.mix, n).map(dbq)) },
  };
}

/* Folds a RoFormer answer for [r.from, ...) into the song's partial curves;
   patches outside it keep what earlier checks measured. */
function addConfirm(store, id, r){
  const song = store.songs[id], ref = song[CURVE_METHOD];
  const n = Buffer.from(ref.q, "base64").length, base = { hopSec:HOP, patchSec:HOP, dur:ref.dur };
  const lv = song[CONFIRM_METHOD] ? [...Buffer.from(song[CONFIRM_METHOD].q, "base64")] : new Array(n).fill(UNMEASURED);
  const wd = song[CONFIRM_WORDS] ? [...Buffer.from(song[CONFIRM_WORDS].q, "base64")] : new Array(n).fill(0);
  if (r){
    const k0 = Math.round(r.from / HOP), m = Math.floor(r.stem.length / BLOCKS);
    const got = patches(r.stem, m), w = wordPatches(r.words, n, r.from);
    for (let i = 0; i < m && k0 + i < n; i++){ lv[k0 + i] = dbq(got[i]); wd[k0 + i] = pq(w[k0 + i]); }
  }
  Object.assign(store.detectors, DETECTORS);
  store.songs[id] = { ...song, [CONFIRM_METHOD]: { ...base, ...DB, q: b64(lv) }, [CONFIRM_WORDS]: { ...base, scale:255, q: b64(wd) } };
}

/* The song's limit (see GATE) and its whole-second windows of `secs` that
   pass, cleanest first (ties to the earlier start). With `confirmed` false
   the RoFormer curves are ignored: that lists the candidates to check. */
function windows(curves, { confirmed = true, secs = SNIP_WINDOW_SEC } = {}){
  const cv = curves?.[CURVE_METHOD], cw = curves?.[WORDS_METHOD];
  if (!cv || !cw) return { limit: null, list: [] };
  const voc = values(cv), n = voc.length, S = cv.hopSec, P = cv.patchSec;
  const heard = (w, st) => w.map((p, k) => (st[k] >= GATE.WORD_FLOOR_DB ? p : 0));
  let level = voc, words = heard(values(cw), voc);
  const sureW = values(cw);
  const sure = [...voc].filter((v, k) => sureW[k] >= GATE.SURE_P && v >= GATE.WORD_FLOOR_DB).sort((a, b) => a - b);
  const sing = sure.length >= GATE.SURE_WORDS ? sure[Math.floor(sure.length / 2)] : null;
  const limit = Math.min(SNIP_VOCAL_MAX_DB, sing === null ? Infinity : sing - GATE.SONG_DROP_DB);
  if (confirmed){
    const rv = curves[CONFIRM_METHOD], rw = curves[CONFIRM_WORDS];
    if (!rv || !rw) return { limit, list: [] };
    const rlv = values(rv), rwd = heard(values(rw), rlv);
    level = voc.map((v, k) => Math.max(v, rlv[k] ?? Infinity));
    words = words.map((p, k) => Math.max(p, rwd[k] ?? 1));
  }
  const span = (a, b) => [Math.max(0, Math.floor((a - P) / S) + 1), Math.min(n - 1, Math.ceil(b / S) - 1)];  // patches overlapping [a, b)
  const list = [];
  for (let t = 0; t + secs + 1 <= Math.floor(cv.dur) && Math.ceil((t + secs) / S) <= n; t++){
    const [k0, k1] = span(t - GATE.LEAD_SEC, t + secs);
    const [w0, w1] = span(t - GATE.LEAD_SEC - GATE.WORD_PAD_SEC, t + secs + GATE.WORD_PAD_SEC);
    let m = -Infinity, said = false;
    for (let k = k0; k <= k1; k++) if (level[k] > m) m = level[k];
    for (let k = w0; k <= w1; k++) if (words[k] >= GATE.WORD_P){ said = true; break; }
    if (!said && m < limit) list.push({ startSec:t, endSec:t + secs, vocalDb:m, limitDb:limit });
  }
  list.sort((a, b) => a.vocalDb - b.vocalDb || a.startSec - b.startSec);
  return { limit, list };
}
const gate = curves => windows(curves).list[0] || null;

/* The stretch a RoFormer check separates for a candidate: everything the
   gate reads for it. */
const confirmSpan = w => ({ from: Math.max(0, w.startSec - GATE.LEAD_SEC - GATE.WORD_PAD_SEC), to: w.endSec + GATE.WORD_PAD_SEC });
function nextCandidate(curves){
  const measured = curves[CONFIRM_METHOD] ? Buffer.from(curves[CONFIRM_METHOD].q, "base64") : null;
  return windows(curves, { confirmed: false }).list.find(w => {
    const { from, to } = confirmSpan(w);
    if (!measured) return true;
    for (let k = Math.floor(from / HOP); k < Math.ceil(to / HOP) && k < measured.length; k++) if (measured[k] === UNMEASURED) return true;
    return false;
  }) || null;
}

/* Every quiet stretch of recognised singing in the corpus, as the gate's
   own numbers see it: the loudest htdemucs patch of each run of sure-word
   patches, absolute and against its song's singing level. The share of
   those runs a limit would let through is how loose it is. */
function calibration(store, ids){
  const abs = [], rel = [];
  let songs = 0;
  for (const id of ids){
    const c = store.songs[id];
    if (!c?.[CURVE_METHOD] || !c[WORDS_METHOD]) continue;
    const voc = values(c[CURVE_METHOD]), w = values(c[WORDS_METHOD]);
    const sure = voc.map((v, k) => w[k] >= GATE.SURE_P && v >= GATE.WORD_FLOOR_DB);
    const lv = [...voc].filter((_, k) => sure[k]).sort((a, b) => a - b);
    if (lv.length < GATE.SURE_WORDS) continue;
    const sing = lv[Math.floor(lv.length / 2)];
    songs++;
    for (let k = 0; k < voc.length; k++){
      if (!sure[k]) continue;
      let j = k, pk = -Infinity;
      while (j < voc.length && sure[j]) pk = Math.max(pk, voc[j++]);
      abs.push(pk); rel.push(pk - sing); k = j;
    }
  }
  if (!abs.length) return;
  const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  const share = (a, lim) => a.filter(v => v < lim).length / a.length;
  console.log(`calibration: ${abs.length} runs of sure words in ${songs} songs; 0.3% quantile ${q(abs, 0.003).toFixed(1)} dBFS and ${q(rel, 0.003).toFixed(1)} dB from the song's level`);
  console.log(`  runs quieter than the ceiling ${SNIP_VOCAL_MAX_DB} dBFS: ${(100 * share(abs, SNIP_VOCAL_MAX_DB)).toFixed(2)}%, more than ${GATE.SONG_DROP_DB} dB under their song: ${(100 * share(rel, -GATE.SONG_DROP_DB)).toFixed(2)}%`);
}

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

/* Writes the index the client should use now (see the header): the v5 one
   judged from the curves once they cover the corpus, else the previous v4
   index, carried over for the songs still in the corpus. */
function publish(store, entries, checked, corpusIds, prev, { final, quiet = false }){
  const covered = [...corpusIds].filter(id => hasCurves(store, id)).length;
  const coverage = corpusIds.size ? covered / corpusIds.size : 0;
  const switched = prev?.v === SNIP_INDEX_V || coverage >= SWITCH_COVERAGE;
  const log = quiet ? () => {} : console.log;
  log(`curve coverage: ${covered}/${corpusIds.size} corpus songs (${Math.round(100 * coverage)}%, switch at ${100 * SWITCH_COVERAGE}%)`);
  if (switched || prev?.v !== SNIP_LEGACY.v){
    const n = writeSnips(SNIP_INDEX_V, entries, checked, corpusIds, { final });
    log(`wrote ${OUT}: v${SNIP_INDEX_V} (${SNIP_METHOD}), ${n} entries`);
    return;
  }
  const accept = SNIP_ACCEPTED[SNIP_LEGACY.v];
  const legacy = Object.fromEntries(Object.entries(prev.snips).filter(([id, e]) =>
    corpusIds.has(id) && e.sourceId === id && e.method === accept.method && accept.clean(e) &&
    Number.isInteger(e.startSec) && e.startSec >= 0 && e.endSec - e.startSec === SNIP_WINDOW_SEC));
  const legacyChecked = Object.fromEntries(Object.entries(prev.checked || {}).filter(([id]) => corpusIds.has(id)));
  const n = writeSnips(SNIP_LEGACY.v, legacy, legacyChecked, corpusIds, { final });
  log(`wrote ${OUT}: still v${SNIP_LEGACY.v} (${SNIP_LEGACY.method}), ${n} entries; v${SNIP_INDEX_V} would hold ${Object.keys(entries).length}`);
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
  publish(store, entries, checked, corpusIds, prev, { final: true });
  writeCurves(store);
  console.log(`${CURVES}: ${Object.keys(store.songs).length} songs with curves`);
  report(entries, checked);
  calibration(store, corpusIds);
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
  console.log(`corpus: ${corpus.length} unique songs (${perLang("bolly")} hindi, ${perLang("telugu")} telugu)`);
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
    publish(store, entries, checked, corpusIds, prev, { final: false, quiet: true });
    writeCurves(store);
  };
  async function ask(job){
    if (!py){ py = startExtractor(); const r = await py.ready(); console.log(`extractor ready: ${r.separators.join(" + ")}, whisper ${r.whisper}`); }
    let r;
    try { r = await py.run(job); }
    catch (e){ py.stop(); py = null; r = { error: e.message }; }
    if (!r.error && r.id !== job.id) r = { error: `answer for ${r.id}` };
    return r;
  }
  async function score(s){
    const t = Date.now(), job = { id:s.id, url:s.stream, lang:s.lang };
    if (!scored(store, s.id)){
      const r = await ask({ op:"song", ...job });
      if (r.error) return `FAIL ${s.title.slice(0, 40)} :: ${r.error.slice(0, 120)}`;
      addSongCurves(store, s.id, r);
    }
    let checks = 0, c;
    while (checks < GATE.CONFIRMS && !gate(store.songs[s.id]) && (c = nextCandidate(store.songs[s.id]))){
      const r = await ask({ op:"confirm", ...job, ...confirmSpan(c) });
      if (r.error){
        // Retried from scratch next time rather than judged half-checked.
        delete store.songs[s.id][CONFIRM_METHOD]; delete store.songs[s.id][CONFIRM_WORDS];
        return `FAIL ${s.title.slice(0, 40)} (confirm) :: ${r.error.slice(0, 120)}`;
      }
      addConfirm(store, s.id, r);
      checks++;
    }
    if (!store.songs[s.id][CONFIRM_METHOD]) addConfirm(store, s.id, null);
    judgeAll([s.id], store, entries, checked);
    const w = entries[s.id];
    if (w) kept++;
    return `${s.lang} ${w ? `vocal=${w.vocalDb}dB (limit ${w.limitDb}) start=${w.startSec}s` : "no clean window"} after ${checks} RoFormer checks, dur=${Math.round(store.songs[s.id][CURVE_METHOD].dur)}s ${Math.round((Date.now() - t) / 1000)}s  ${s.title.slice(0, 40)}`;
  }

  for (const [pass, list] of [["", todo], ["retry ", null]]){
    const songs = list || failures.splice(0, failures.length);
    if (!list && songs.length) console.log(`\nretrying ${songs.length} failed songs once...`);
    for (const s of songs){
      if (Date.now() - t0 > BUDGET_MS){ console.log(`time budget spent; ${songs.length - songs.indexOf(s)} songs left for the next run`); break; }
      const line = await score(s);
      done++;
      if (line.startsWith("FAIL")) failures.push(s);
      console.log(`${pass}${String(done).padStart(3)}/${todo.length} ${line}`);
      if (++sinceWrite >= PROGRESS_EVERY){ sinceWrite = 0; progress(); }
    }
  }
  if (py) py.stop();

  console.log(`\n${kept} passed of ${done} scored in ${Math.round((Date.now() - t0) / 60000)}min`);
  publish(store, entries, checked, corpusIds, prev, { final: SHARDS === 1 });
  writeCurves(store);
  console.log(`${failures.length} failed after retry`);
  console.log(`${Object.keys(checked).length} source IDs rejected by ${CHECKED_METHOD}`);
  report(entries, checked);
  calibration(store, corpusIds);
})().catch(e => { console.error("build-snips failed:", e); process.exit(1); });
