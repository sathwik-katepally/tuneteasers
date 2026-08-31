/* Audio engine - the ONLY owner of playback.
   Every action bumps `session`. Any async continuation from an older session
   is ignored, so two songs can never play at once.

   The client no longer downloads/decodes/processes audio buffers: per-song
   instrumental windows are computed offline (scripts/build-snips.mjs) and
   shipped in snips.json. Playback is plain <audio> elements:
     "snip"   - track has a verified instrumental window (track.snip): seek
                to it and play raw. No Web Audio processing at all.
     "muffle" - no verified window: route the element through a realtime
                biquad muffle graph (needs crossOrigin="anonymous"; the
                Saavn and iTunes hosts both serve CORS-readable audio).
     "plain"  - as-is element playback (vocal-audible fallback, and reveals).
   window.__ttLastMode reports the mode that actually played (E2E surface). */
import { log, errMsg } from "./log.js";

const STALL_MS = 12000; // a dead or stalled stream must not pin the game on "Cueing it up…"

/* Realtime vocal muffle for unverified tracks: the legacy biquad chain,
   element edition. Element playback has no offline L−R trick, so this is the
   simple version - bass foundation branch + formant cuts + top-end lowpass. */
function buildMuffleGraph(c, src){
  const out = c.createGain();
  const bass = c.createBiquadFilter(); bass.type="lowpass"; bass.frequency.value=140;
  const bassG = c.createGain(); bassG.gain.value=0.9;
  src.connect(bass); bass.connect(bassG); bassG.connect(out);
  const cut1 = c.createBiquadFilter(); cut1.type="peaking"; cut1.frequency.value=1200; cut1.Q.value=0.9; cut1.gain.value=-10;
  const cut2 = c.createBiquadFilter(); cut2.type="peaking"; cut2.frequency.value=3000; cut2.Q.value=0.9; cut2.gain.value=-9;
  const hiLp = c.createBiquadFilter(); hiLp.type="lowpass"; hiLp.frequency.value=6500;
  src.connect(cut1); cut1.connect(cut2); cut2.connect(hiLp); hiLp.connect(out);
  return out;
}

export const engine = {
  ctx:null, el:null, pre:null, timer:null, session:0,
  ac(){
    if (!this.ctx) this.ctx = new (window.AudioContext||window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  stop(){
    this.session++;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    if (this.el){ this.el.pause(); }
  },
  _mark(m){ try { window.__ttLastMode = m; } catch(e){} }, // E2E/debug surface
  /* Get the playback element for a URL, adopting the prefetched one when it
     matches. `cors` elements (muffle candidates) are kept separate from plain
     ones: crossOrigin cannot change after the source has loaded. */
  _el(url, cors){
    const want = cors ? "1" : "";
    if (this.el && this.el.dataset.src === url && this.el.dataset.cors === want && !this.el.error) return this.el;
    if (this.pre && this.pre.dataset.src === url && this.pre.dataset.cors === want && !this.pre.error){
      this.el = this.pre; this.pre = null; return this.el;
    }
    const el = new Audio();
    if (cors) el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.dataset.src = url;
    el.dataset.cors = want;
    el.src = url;
    this.el = el;
    return el;
  },
  /* Resolves true once metadata is ready (seekable), false on error/stall. */
  _ready(el){
    if (el.readyState >= 1) return Promise.resolve(true);
    return new Promise(res => {
      let guard = null;
      const done = ok => { if (guard){ clearTimeout(guard); guard = null; }
        el.removeEventListener("loadedmetadata", onOk); el.removeEventListener("error", onErr); res(ok); };
      const onOk = () => done(true), onErr = () => done(false);
      guard = setTimeout(() => done(false), STALL_MS);
      el.addEventListener("loadedmetadata", onOk);
      el.addEventListener("error", onErr);
    });
  },
  /* Snippet playback for Music-only mode.
     Returns the mode that played ("snip" | "muffle" | "plain") or
     "failed" | "superseded"; callers must treat "superseded" as "do nothing"
     (a newer user action owns playback).
     `offset` (replay/extend) is relative to the snip start; extends and the
     15s snippet setting may run past the ~10-12s verified window (owner-accepted). */
  async playSnippet(track, offset, secs, onEnd){
    this.stop();
    const s = this.session;
    const url = track.stream;
    const id = url.slice(-24); // enough to correlate log lines without full URLs
    const snip = Number.isFinite(track.snip) ? track.snip : null;
    const el = this._el(url, snip === null);
    const ok = await this._ready(el);
    if (s !== this.session) return "superseded";
    if (!ok){ log("element-fail", { id, err: el.error ? el.error.code : "stall" }); return "failed"; }
    let mode = snip === null ? "muffle" : "snip";
    if (mode === "muffle"){
      try { // wire the element through the realtime muffle graph; wiring failure means vocals stay audible ("plain")
        const c = this.ac();
        if (!el._ttSrc) el._ttSrc = c.createMediaElementSource(el);
        if (el._ttOut) el._ttOut.disconnect();
        el._ttSrc.disconnect();
        el._ttOut = buildMuffleGraph(c, el._ttSrc);
        el._ttOut.connect(c.destination);
      } catch(e){ log("muffle-wire-fail", { id, msg: errMsg(e) }); mode = "plain"; }
    }
    try { el.currentTime = (snip || 0) + offset; } catch(e){}
    const p = el.play(); if (p) p.catch(()=>{});
    this._mark(mode);
    log("play", { id, mode, ...(snip !== null ? { snip } : {}), offset, secs });
    this.timer = setTimeout(() => { if (s === this.session){ el.pause(); onEnd && onEnd(); } }, secs*1000);
    return mode;
  },
  /* Light prefetch: a preload="auto" element for the next track, at most one.
     It never plays; playSnippet/playElement adopt it when the URL matches. */
  prefetch(track){
    if (!track || !track.stream) return;
    const url = track.stream;
    if ((this.el && this.el.dataset.src === url) || (this.pre && this.pre.dataset.src === url)) return;
    if (this.pre){ try { this.pre.removeAttribute("src"); this.pre.load(); } catch(e){} } // cancel the old one
    const el = new Audio();
    const cors = !Number.isFinite(track.snip); // it would play "muffle", which needs CORS
    if (cors) el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.dataset.src = url;
    el.dataset.cors = cors ? "1" : "";
    el.src = url;
    this.pre = el;
  },
  /* As-is playback (mode "plain"): reveals, With-vocals snippets, and the
     vocal-audible fallback. secs=0 plays to the end of the stream. */
  playElement(url, offset, secs, onEnd, onErr){
    this.stop();
    log("element-play", { id: url.slice(-24), offset: Math.round(offset), secs });
    const s = this.session;
    let el;
    if (this.el && this.el.dataset.src === url && !this.el.error) el = this.el; // any cors flavor; rewired direct below
    else el = this._el(url, false);
    let guard = null;
    const fail = () => {
      if (guard){ clearTimeout(guard); guard = null; }
      log("element-fail", { id: url.slice(-24), err: el.error ? el.error.code : "stall" });
      if (s === this.session && onErr) onErr();
    };
    const go = () => {
      if (guard){ clearTimeout(guard); guard = null; }
      if (s !== this.session) return; // superseded while loading - never plays
      if (el._ttSrc){ // element was muffled earlier: route it straight to the speakers
        try { if (el._ttOut){ el._ttOut.disconnect(); el._ttOut = null; }
          el._ttSrc.disconnect(); el._ttSrc.connect(this.ac().destination); } catch(e){}
      }
      try { el.currentTime = offset; } catch(e){}
      const p = el.play(); if (p) p.catch(()=>{});
      this._mark("plain");
      if (secs) this.timer = setTimeout(() => { if (s === this.session){ el.pause(); onEnd && onEnd(); } }, secs*1000);
    };
    if (el.readyState >= 1) go();
    else {
      guard = setTimeout(fail, STALL_MS);
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
