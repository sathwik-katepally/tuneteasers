/* Audio engine — the ONLY owner of playback.
   Every action bumps `session`. Any async continuation from an older session
   is ignored, so two songs can never play at once. */
import { suppressVocals } from "./suppress.js";
import { pickSnippetWindow } from "./snippick.js";
import { pickWindowVAD } from "./vad.js";
import { mlAvailable, mlReason, separateBuffer } from "./mlsep.js";
import { log, ms, errMsg } from "./log.js";

/* Post-suppression shaping: the cascade already treats the band up to 14kHz,
   so the lowpass only dulls the very top where residual sibilance could sit. */
function buildMildGraph(c, src){
  const lp = c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=12000;
  const cut = c.createBiquadFilter(); cut.type="peaking"; cut.frequency.value=2500; cut.Q.value=1; cut.gain.value=-5;
  const makeup = c.createGain(); makeup.gain.value = 1.15;
  src.connect(lp); lp.connect(cut); cut.connect(makeup);
  return makeup;
}
/* Fallback when centercut couldn't run (mono track, or processing failed):
   the previous muffle chain — bass foundation + L−R when stereo + formant cuts. */
function buildLegacyGraph(c, src, channels){
  const out = c.createGain();
  const lp = c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=140;
  const lpG = c.createGain(); lpG.gain.value=0.9;
  src.connect(lp); lp.connect(lpG); lpG.connect(out);
  let mainIn;
  if (channels >= 2){
    const sp = c.createChannelSplitter(2);
    const gL = c.createGain(); gL.gain.value = 1;
    const gR = c.createGain(); gR.gain.value = -1;
    const diff = c.createGain(); diff.gain.value = 1.8;
    src.connect(sp); sp.connect(gL,0); sp.connect(gR,1);
    gL.connect(diff); gR.connect(diff);
    mainIn = diff;
  } else { mainIn = c.createGain(); src.connect(mainIn); }
  const cut1 = c.createBiquadFilter(); cut1.type="peaking"; cut1.frequency.value=1200; cut1.Q.value=0.9; cut1.gain.value=-10;
  const cut2 = c.createBiquadFilter(); cut2.type="peaking"; cut2.frequency.value=3000; cut2.Q.value=0.9; cut2.gain.value=-9;
  const hiLp = c.createBiquadFilter(); hiLp.type="lowpass"; hiLp.frequency.value=6500;
  mainIn.connect(cut1); cut1.connect(cut2); cut2.connect(hiLp); hiLp.connect(out);
  return out;
}

export const engine = {
  ctx:null, el:null, srcNode:null, timer:null, session:0,
  cache: new Map(), // url -> Promise<{ buf, mode }> for the current and prefetched tracks
  _urgent: new Map(), // url -> resolver that cuts a pending load's VAD wait short
  ac(){
    if (!this.ctx) this.ctx = new (window.AudioContext||window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  stop(){
    this.session++;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    if (this.srcNode){ try{ this.srcNode.stop(); }catch(e){} this.srcNode = null; }
    if (this.el){ this.el.pause(); }
  },
  slice(buf, startSec, secs){
    const c = this.ac(), sr = buf.sampleRate;
    const from = Math.max(0, Math.min(Math.floor(startSec*sr), buf.length - sr));
    const len = Math.min(buf.length - from, Math.floor(secs*sr));
    const nb = c.createBuffer(buf.numberOfChannels, len, sr);
    for (let ch=0; ch<buf.numberOfChannels; ch++) nb.copyToChannel(buf.getChannelData(ch).subarray(from, from+len), ch);
    return nb;
  },
  ensureBuf(url, patient){
    let p = this.cache.get(url);
    if (!p){
      p = this._load(url, patient);
      this.cache.set(url, p);
      if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
      p.catch(()=>{ if (this.cache.get(url) === p) this.cache.delete(url); }); // never cache failures
    }
    return p;
  },
  async _load(url, patient){
    const id = url.slice(-24); // enough to correlate log lines without full URLs
    const t0 = performance.now();
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    const tFetch = ms(t0);
    let full = await this.ac().decodeAudioData(ab);
    const tDecode = ms(t0) - tFetch;
    // Pick the most instrumental stretch. ML separation still runs on every
    // picked window on capable devices (the vocal-activity detector is only a
    // heuristic; wide/doubled vocals evade it), but it must never hold up the
    // first play: ML gets a short head start, then the DSP result plays and
    // the cache entry upgrades to the ML buffer in place once inference lands
    // (replays, extends, and prefetched tracks all read the upgraded entry).
    const mark = m => { try { window.__ttLastMode = m; } catch(e){} }; // E2E/debug surface
    // Window choice: the learned VAD (MusiCNN) is the trusted picker; the
    // snippick heuristic is its fallback. Both run in parallel. A patient
    // load (background warming — the common case) gives the VAD 10s, which
    // with fetch+decode+suppression stays under playMuffled's 20s cue
    // timeout; an impatient one gets 4s. A VAD verdict that arrives too late
    // still lands in the per-URL cache, so the song's next appearance wins.
    let start = 0, clean = false, diag = null;
    const vadP = pickWindowVAD(full, url);
    const heurP = pickSnippetWindow(full).catch(e => { log("pick-error", { id, msg: errMsg(e) }); return { start: 0, clean: false, diag: null }; });
    // A patient wait must collapse the moment the user actually hits play:
    // playMuffled resolves this promise, and the race falls through to the
    // heuristic immediately instead of sitting out the rest of the VAD cap.
    const urgent = new Promise(r => this._urgent.set(url, r));
    let pick = await Promise.race([vadP, urgent, new Promise(r => setTimeout(() => r(undefined), patient ? 10000 : 4000))]);
    this._urgent.delete(url);
    const picker = pick ? "vad" : "heur";
    if (!pick) pick = await heurP;
    ({ start, clean, diag } = pick);
    log("load", { id, kb: Math.round(ab.byteLength/1024), fetchMs: tFetch, decodeMs: tDecode,
      dur: Math.round(full.duration), picker, start: Math.round(start), clean, ...diag });
    const buf = this.slice(full, start, 45);
    full = null; // the decoded full song is ~100MB; let it go before suppression runs
    // The "clean" verdict is telemetry only (logged above), never a reason to
    // skip processing: measured on real songs, 7/8 heuristic windows passed it
    // while still carrying audible vocals. Raw playback is earned only by ML.
    const dsp = async () => {
      if (buf.numberOfChannels >= 2){
        try { return { buf: await suppressVocals(buf, this.ac()), mode: "cut" }; }
        catch(e){ log("suppress-fail", { id, msg: errMsg(e) }); }
      }
      return { buf, mode: "legacy" };
    };
    const entry = { buf, mode: "pending" };
    if (!mlAvailable()){
      const r = await dsp();
      entry.buf = r.buf; entry.mode = r.mode;
      mark(entry.mode);
      log("mode", { id, mode: entry.mode, ml: mlReason(), totalMs: ms(t0) });
      return entry;
    }
    const tMl = performance.now();
    const mlP = separateBuffer(buf, this.ac())
      .then(mlBuf => { entry.buf = mlBuf; entry.mode = "ml"; mark("ml"); log("ml-upgrade", { id, ms: ms(tMl) }); })
      .catch(e => { log("ml-fail", { id, msg: errMsg(e), ms: ms(tMl) }); });
    await Promise.race([mlP, new Promise(r=>setTimeout(r, 3500))]);
    if (entry.mode === "pending"){
      const r = await dsp();
      if (entry.mode === "pending"){ entry.buf = r.buf; entry.mode = r.mode; } // ML may have landed while centerCut ran
    }
    mark(entry.mode);
    log("mode", { id, mode: entry.mode, ml: "ok", totalMs: ms(t0) });
    return entry;
  },
  prefetch(url){ if (url) this.ensureBuf(url, true).catch(()=>{}); },
  /* returns "played" | "failed" | "superseded" */
  async playMuffled(url, offset, secs, onEnd){
    this.stop();
    const s = this.session;
    const poke = this._urgent.get(url);
    if (poke) poke(undefined); // the user is waiting now: stop being patient
    let entry;
    try { // bound the cueing wait: a stalled fetch must not pin the game on "Cueing it up…"
      entry = await Promise.race([
        this.ensureBuf(url), // keeps loading in the background even if the race times out, so replays can still hit the cache
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("cue timeout")), 20000)), // must outlast fetch+decode+VAD cap+suppression
      ]);
    } catch(e){
      log("cue-fail", { id: url.slice(-24), msg: errMsg(e) });
      return (s===this.session) ? "failed" : "superseded";
    }
    if (s !== this.session) return "superseded";
    const { buf, mode } = entry;
    if (offset >= buf.duration - 1){ log("cue-fail", { id: url.slice(-24), msg: "offset past buffer", offset }); return "failed"; }
    log("play", { id: url.slice(-24), mode, offset, secs });
    const c = this.ac();
    const src = c.createBufferSource(); src.buffer = buf;
    let out;
    if (mode === "raw" || mode === "ml"){ out = c.createGain(); src.connect(out); } // untouched audio
    else if (mode === "cut") out = buildMildGraph(c, src);
    else out = buildLegacyGraph(c, src, buf.numberOfChannels);
    out.connect(c.destination);
    src.start(0, offset, secs);
    this.srcNode = src;
    this.timer = setTimeout(()=>{ if (s === this.session) onEnd && onEnd(); }, secs*1000);
    return "played";
  },
  playElement(url, offset, secs, onEnd, onErr){
    this.stop();
    log("element-play", { id: url.slice(-24), offset: Math.round(offset), secs }); // vocals-intact path
    const s = this.session;
    if (!this.el || this.el.dataset.src !== url){
      this.el = new Audio(url);
      this.el.preload = "auto";
      this.el.dataset.src = url;
    }
    const el = this.el;
    let guard = null; // dead or stalled streams must not leave the game waiting forever
    const fail = () => {
      if (guard){ clearTimeout(guard); guard = null; }
      log("element-fail", { id: url.slice(-24), err: el.error ? el.error.code : "stall" });
      if (s === this.session && onErr) onErr();
    };
    const go = () => {
      if (guard){ clearTimeout(guard); guard = null; }
      if (s !== this.session) return; // superseded while loading — never plays
      try { el.currentTime = offset; } catch(e){}
      const p = el.play(); if (p) p.catch(()=>{});
      if (secs) this.timer = setTimeout(()=>{ if (s === this.session){ el.pause(); onEnd && onEnd(); } }, secs*1000);
    };
    if (el.readyState >= 1) go();
    else {
      guard = setTimeout(fail, 12000);
      el.addEventListener("loadedmetadata", go, { once:true });
      el.addEventListener("error", fail, { once:true });
    }
  },
};

let wakeLock = null;
export async function keepAwake(on){
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock){ wakeLock.release(); wakeLock = null; }
  } catch(e){}
}
