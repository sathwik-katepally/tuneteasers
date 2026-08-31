/* Singing-voice detection (VAD) — learned replacement for the snippick
   heuristic's window choice. Scores p(voice) for every ~3s patch of the song
   with a 3MB MusiCNN classifier in a worker, then picks the window whose
   WORST patch is quietest. The heuristic's center-correlation score misses
   wide/doubled film-song vocals (measured 7/8 false-clean); MusiCNN is
   trained on full mixes, so those are its training distribution.
   Model: essentia voice_instrumental-musicnn-msd-2 (CC BY-NC-SA 4.0,
   Music Technology Group UPF — see docs/audio.md for attribution). */
import { isIOS } from "./utils.js";
import { log, ms, errMsg } from "./log.js";

export const VAD = {
  windowSec: 25,     // desired stretch: snippet plus replay/extend headroom
  cleanMax: 0.25,    // window max p(voice) below this = genuinely instrumental
  timeoutMs: 90000,  // a wedged worker must not pin the pipeline forever
};

/* The essentia mel extraction leaks WASM heap on every frame it processes
   (measured: the scoring worker's process grows by well over 1GB per full
   song, and WASM memory never shrinks). On iOS that jetsam-kills the tab
   mid-game, so the VAD is skipped there outright — snippick picks the
   window, the same policy as ML separation. Elsewhere the worker is
   recycled after every job (see below) so the OS reclaims the heap. */
export function vadReason(){ return isIOS ? "ios" : "ok"; }
export const vadAvailable = () => vadReason() === "ok";

let worker = null, seq = 0;
const pending = new Map();

function getWorker(){
  if (!worker){
    worker = new Worker(new URL("./vad.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ev => {
      const p = pending.get(ev.data.seq);
      if (p){ pending.delete(ev.data.seq); p(ev.data); }
    };
    worker.onerror = () => { // worker died: fail everything in flight, allow recreate
      for (const p of pending.values()) p({ error: "worker crashed" });
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

/* Terminating the worker is the only way to reclaim the WASM memory the
   scoring stack leaks per job; it also prevents the heap corruption a reused
   essentia instance develops after a few songs. Deferred while other jobs
   are in flight so their replies aren't lost. */
function recycleWorker(){
  try { if (worker) worker.terminate(); } catch(e){}
  for (const p of pending.values()) p({ error: "worker recycled" });
  pending.clear();
  worker = null;
}

/* Start loading the worker + model in the background (call at game start). */
export function vadWarmup(){
  if (!vadAvailable()) return;
  try {
    const base = new URL(import.meta.env.BASE_URL, self.location.href).href;
    getWorker().postMessage({ warm: true, base });
  } catch(e){}
}

async function to16kMono(buf){
  const len = Math.ceil(buf.duration * 16000);
  const oc = new OfflineAudioContext(1, len, 16000);
  const src = oc.createBufferSource(); src.buffer = buf;
  src.connect(oc.destination); src.start();
  return (await oc.startRendering()).getChannelData(0);
}

/* Scoring a song costs seconds, and crates repeat songs across games, so
   verdicts persist per stream URL (device-local, like everything else). */
const LS_KEY = "tt_vad";
function cacheGet(key){
  try { return (JSON.parse(localStorage.getItem(LS_KEY)) || {})[key] || null; } catch(e){ return null; }
}
function cachePut(key, val){
  try {
    const m = JSON.parse(localStorage.getItem(LS_KEY)) || {};
    m[key] = val;
    const ks = Object.keys(m);
    for (let i = 0; ks.length - i > 300; i++) delete m[ks[i]];
    localStorage.setItem(LS_KEY, JSON.stringify(m));
  } catch(e){}
}

/* Returns { start, clean, diag } like pickSnippetWindow, or null when the
   model can't answer (load failure, timeout) — caller falls back to the
   heuristic. Never throws. */
export async function pickWindowVAD(buf, url){
  const t0 = performance.now();
  const key = String(url || "").slice(-40);
  const hit = key && cacheGet(key);
  if (hit) return { start: hit.s, clean: !!hit.c, diag: { vad: 1, cached: 1, winMax: hit.w } };
  if (!vadAvailable()) return null; // iOS: memory-unsafe (see vadReason) — heuristic picks
  try {
    const pcm = await to16kMono(buf);
    const base = new URL(import.meta.env.BASE_URL, self.location.href).href;
    const id = ++seq;
    const result = await new Promise(resolve => {
      pending.set(id, resolve);
      getWorker().postMessage({ pcm, base, seq: id }, [pcm.buffer]);
      setTimeout(() => {
        if (pending.has(id)){ pending.delete(id); resolve({ error: "vad timeout" }); }
      }, VAD.timeoutMs);
    });
    if (result.error){
      log("vad-fail", { msg: result.error, ms: ms(t0) });
      recycleWorker();
      return null;
    }
    if (pending.size === 0) recycleWorker(); // reclaim the job's leaked WASM heap
    const { probs, hopSec } = result;
    if (!probs || probs.length < 2){ log("vad-fail", { msg: "too few patches", ms: ms(t0) }); return null; }
    // median-of-3 smoothing knocks out single-patch blips
    const sm = Float32Array.from(probs);
    for (let i = 1; i < probs.length - 1; i++){
      const a = probs[i-1], b = probs[i], c = probs[i+1];
      sm[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
    // pick the window whose worst patch is quietest (ties go earlier)
    const winPatches = Math.max(1, Math.min(sm.length, Math.round(VAD.windowSec / hopSec)));
    let bestIdx = 0, bestMax = Infinity;
    for (let i = 0; i + winPatches <= sm.length; i++){
      let mx = 0;
      for (let j = i; j < i + winPatches; j++) if (sm[j] > mx) mx = sm[j];
      if (mx < bestMax - 1e-6){ bestMax = mx; bestIdx = i; }
    }
    const rnd = x => Math.round(x * 1000) / 1000;
    const out = {
      start: bestIdx * hopSec,
      clean: bestMax < VAD.cleanMax,
      diag: { vad: 1, winMax: rnd(bestMax), songMax: rnd(Math.max(...sm)), songMin: rnd(Math.min(...sm)), patches: sm.length },
    };
    log("vad", { ...out.diag, start: Math.round(out.start), clean: out.clean, ms: ms(t0) });
    if (key) cachePut(key, { s: Math.round(out.start * 10) / 10, c: out.clean ? 1 : 0, w: out.diag.winMax });
    return out;
  } catch (e){
    log("vad-fail", { msg: errMsg(e), ms: ms(t0) });
    return null;
  }
}

if (typeof window !== "undefined") window.__ttVad = pickWindowVAD; // exercised by the VAD E2E test
