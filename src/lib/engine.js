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
   window.__ttLastMode reports the mode that actually played (E2E surface).
   Game sound effects are synthesised on the same AudioContext (sfx), so the
   engine stays the only thing in the app that makes a sound. */
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
     `offset` is relative to the snip start; the 12s top rung of the clip
     ladder may run past the ~10-12s verified window (owner-accepted).
     cb: { onEnd, onBlocked } - onBlocked fires when the browser refuses to
     start audio without a fresh tap (autoplay policy). */
  async playSnippet(track, offset, secs, cb = {}){
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
    el.muted = false;
    this._play(el, s, id, cb.onBlocked);
    this._mark(mode);
    log("play", { id, mode, ...(snip !== null ? { snip } : {}), offset, secs });
    this.timer = setTimeout(() => { if (s === this.session){ el.pause(); cb.onEnd && cb.onEnd(); } }, secs*1000);
    return mode;
  },
  _play(el, s, id, onBlocked){
    const p = el.play();
    if (p) p.catch(e => {
      if (!e || e.name !== "NotAllowedError" || s !== this.session) return;
      log("play-blocked", { id });
      this.stop();
      onBlocked && onBlocked();
    });
  },
  /* Light prefetch: a preload="auto" element for the next track, at most one.
     It never plays; playSnippet/playElement adopt it when the URL matches.
     `plain` marks a track that will play as-is (With-vocals), which must not
     be a CORS element or playElement would refetch it. */
  prefetch(track, plain){
    if (!track || !track.stream) return;
    const url = track.stream;
    if ((this.el && this.el.dataset.src === url) || (this.pre && this.pre.dataset.src === url)) return;
    if (this.pre){ try { this.pre.removeAttribute("src"); this.pre.load(); } catch(e){} } // cancel the old one
    const el = new Audio();
    const cors = !plain && !Number.isFinite(track.snip); // it would play "muffle", which needs CORS
    if (cors) el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.dataset.src = url;
    el.dataset.cors = cors ? "1" : "";
    el.src = url;
    this.pre = el;
  },
  /* Unlock the track's element inside a tap. iOS only lets an element start
     audio from a timer (the countdown) once it has been played from a user
     gesture, so this plays it muted for a moment and pauses it again. */
  prime(track, plain){
    if (!track || !track.stream) return;
    this.ac();
    const el = this._el(track.stream, !plain && !Number.isFinite(track.snip));
    const s = this.session;
    el.muted = true;
    const restore = () => { if (s === this.session) el.pause(); el.muted = false; };
    try { const p = el.play(); if (p) p.then(restore, restore); else restore(); } catch(e){ restore(); }
  },
  /* As-is playback (mode "plain"): reveals, With-vocals snippets, and the
     vocal-audible fallback. secs=0 plays to the end of the stream.
     cb: { onStart, onEnd, onErr, onBlocked } */
  playElement(url, offset, secs, cb = {}){
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
      if (s === this.session && cb.onErr) cb.onErr();
    };
    const go = () => {
      if (guard){ clearTimeout(guard); guard = null; }
      if (s !== this.session) return; // superseded while loading - never plays
      if (el._ttSrc){ // element was muffled earlier: route it straight to the speakers
        try { if (el._ttOut){ el._ttOut.disconnect(); el._ttOut = null; }
          el._ttSrc.disconnect(); el._ttSrc.connect(this.ac().destination); } catch(e){}
      }
      try { el.currentTime = offset; } catch(e){}
      el.muted = false;
      this._play(el, s, url.slice(-24), cb.onBlocked);
      this._mark("plain");
      cb.onStart && cb.onStart();
      if (secs) this.timer = setTimeout(() => { if (s === this.session){ el.pause(); cb.onEnd && cb.onEnd(); } }, secs*1000);
    };
    if (el.readyState >= 1) go();
    else {
      guard = setTimeout(fail, STALL_MS);
      el.addEventListener("loadedmetadata", go, { once:true });
      el.addEventListener("error", fail, { once:true });
    }
  },
  /* Synthesised game sounds; nothing to download. Unknown names are ignored.
     Called from timers too, so it never creates or resumes the context on
     its own: a tap has to have called ac() first. */
  sfx(name){
    const c = this.ctx;
    if (!c || c.state !== "running") return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      const out = c.createGain();
      out.gain.value = 0.6;
      out.connect(c.destination);
      fn(c, out, c.currentTime + 0.01, noise(c));
    } catch(e){ log("sfx-fail", { name, msg: errMsg(e) }); }
  },
};

let noiseBuf = null;
function noise(c){
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
function tone(c, out, t, { type = "sine", from, to = from, dur, vol }){
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out);
  o.start(t); o.stop(t + dur + 0.02);
}
function burst(c, out, t, buf, { dur, vol, type = "bandpass", freq = 1800, q = 0.8 }){
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf;
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t, Math.random() * 0.3, dur + 0.02);
}
const SFX = {
  // a marquee bulb clicking on, one per countdown number
  tick: (c, out, t, n) => { burst(c, out, t, n, { dur: 0.03, vol: 0.5, freq: 3200, q: 2 }); tone(c, out, t, { type: "triangle", from: 1320, dur: 0.09, vol: 0.12 }); },
  roll: (c, out, t) => { tone(c, out, t, { type: "triangle", from: 660, dur: 0.14, vol: 0.16 }); tone(c, out, t + 0.1, { type: "triangle", from: 990, dur: 0.3, vol: 0.16 }); },
  // rubber stamp on paper: a low thud under a short papery slap
  stamp: (c, out, t, n) => { tone(c, out, t, { from: 140, to: 48, dur: 0.28, vol: 0.9 }); burst(c, out, t, n, { dur: 0.09, vol: 0.7, type: "lowpass", freq: 1400, q: 0.5 }); },
  // projector sputter: a gate of rapid shutter clicks that slows and dies
  projector: (c, out, t, n) => {
    for (let i = 0, at = t; i < 14; i++, at += 0.045 + i * 0.006) burst(c, out, at, n, { dur: 0.025, vol: 0.35 * (1 - i / 16), freq: 2400, q: 1.2 });
    tone(c, out, t, { type: "sawtooth", from: 110, to: 70, dur: 0.8, vol: 0.05 });
  },
  // split-flap board settling
  flaps: (c, out, t, n) => { for (let i = 0; i < 9; i++) burst(c, out, t + i * 0.055 + Math.random() * 0.02, n, { dur: 0.018, vol: 0.28, type: "highpass", freq: 2600, q: 0.7 }); },
  fanfare: (c, out, t) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, out, t + i * 0.12, { type: "triangle", from: f, dur: i === 3 ? 0.7 : 0.2, vol: 0.14 })); },
};

let wakeLock = null;
export async function keepAwake(on){
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock){ wakeLock.release(); wakeLock = null; }
  } catch(e){}
}
