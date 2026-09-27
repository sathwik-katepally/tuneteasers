/* Audio engine - the ONLY owner of playback.
   Every action bumps `session`. Any async continuation from an older session
   is ignored, so two songs can never play at once.

   The client no longer downloads/decodes/processes audio buffers: per-song
   instrumental windows are computed offline (scripts/build-snips.mjs) and
   shipped in snips.json. Music-only uses a verified interval and an
   AudioContext gain gate at its end. Easy and reveals play as-is.
   window.__ttLastMode reports the mode that actually played (E2E surface).
   Game sound effects are synthesised on the same AudioContext (sfx), so the
   engine stays the only thing in the app that makes a sound. */
import { log, errMsg } from "./log.js";
import { SNIP_WINDOW_SEC } from "./constants.js";

const STALL_MS = 12000; // a dead or stalled stream must not pin the game on "Cueing it up…"

export const engine = {
  ctx:null, el:null, pre:null, timer:null, boundary:null, session:0,
  ac(){
    if (!this.ctx) this.ctx = new (window.AudioContext||window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  stop(){
    this.session++;
    if (this.timer){ clearTimeout(this.timer); this.timer = null; }
    if (this.boundary && this.el) this.el.removeEventListener("playing", this.boundary);
    this.boundary = null;
    if (this.el?._ttOut){ this.el._ttOut.gain.cancelScheduledValues(0); this.el._ttOut.gain.value = 0; }
    if (this.el){ if (!this.el.paused) this.el._ttPaused = true; this.el.pause(); }
  },
  _mark(m){ try { window.__ttLastMode = m; } catch(e){} }, // E2E/debug surface
  /* Get the playback element for a URL, adopting the prefetched one when it
     matches. CORS and plain elements stay separate after loading. */
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
  /* Music-only plays only inside a verified SNIP_WINDOW_SEC interval;
     offset and secs are relative to its start. A gain gate cuts output on
     the AudioContext clock even if JS timers lag. */
  async playSnippet(track, offset, secs, cb = {}){
    this.stop();
    const s = this.session;
    const snip = track?.snip;
    if (!snip || !track.sourceId || snip.sourceId !== track.sourceId ||
        typeof snip.indexBuilt !== "string" || !snip.indexBuilt ||
        !Number.isFinite(snip.startSec) || !Number.isFinite(snip.endSec) ||
        snip.startSec < 0 || snip.endSec - snip.startSec !== SNIP_WINDOW_SEC ||
        !Number.isFinite(offset) || !Number.isFinite(secs) || offset < 0 || secs <= 0 ||
        offset + secs > SNIP_WINDOW_SEC) return "failed";
    const url = track.stream;
    const id = url.slice(-24); // enough to correlate log lines without full URLs
    const el = this._el(url, true);
    const ok = await this._ready(el);
    if (s !== this.session) return "superseded";
    if (!ok){ log("element-fail", { id, err: el.error ? el.error.code : "stall" }); return "failed"; }
    let gate;
    const target = snip.startSec + offset;
    try {
      // After a pause, seek even to where the element already is: Chromium
      // resumes a paused element ~60ms past its pause point unless a seek
      // flushes it, and the tail past the last stop was gated silent anyway.
      // An element that never started (a refused autoplay) skips the seek so
      // "Tap to play" can call play() inside the tap.
      if (el._ttPaused || Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
      el._ttPaused = false;
      if (el.seeking) await new Promise((resolve, reject) => {
        const guard = setTimeout(() => { el.removeEventListener("seeked", done); reject(new Error("seek stalled")); }, STALL_MS);
        const done = () => { clearTimeout(guard); resolve(); };
        el.addEventListener("seeked", done, { once:true });
      });
      if (s !== this.session) return "superseded";
      if (Math.abs(el.currentTime - target) > 0.1) throw new Error("seek missed interval");
      const c = this.ac();
      if (!el._ttSrc) el._ttSrc = c.createMediaElementSource(el);
      if (el._ttOut) el._ttOut.disconnect();
      el._ttSrc.disconnect();
      gate = c.createGain();
      gate.gain.setValueAtTime(1, c.currentTime);
      gate.gain.setValueAtTime(0, c.currentTime + secs);
      el._ttSrc.connect(gate); gate.connect(c.destination);
      el._ttOut = gate;
    } catch(e){ log("snip-fail", { id, msg:errMsg(e) }); return "failed"; }
    el.muted = false;
    this._clip(el, s, id, snip.startSec + offset + secs, gate, cb);
    this._play(el, s, id, cb.onBlocked, cb.onErr);
    this._mark("snip");
    log("play", { id, mode:"snip", snip:snip.startSec, offset, secs });
    return "snip";
  },
  /* Stop a clip at media time `end`. The clip counts as started (onStart)
     only when audio is actually flowing, so the UI never runs ahead of the
     sound. Timers re-aim at the end from the element's own clock, and for a
     gated element the gate close is re-aimed on the audio clock each tick. */
  _clip(el, s, id, end, gate, cb){
    let started = false, lastTime = -1, movedAt = performance.now(), startGuard = 0;
    const trace = { mode: gate ? "snip" : "plain", end, from: null, to: null };
    const finish = stalled => {
      if (s !== this.session) return;
      if (gate){ gate.gain.cancelScheduledValues(0); gate.gain.value = 0; }
      el.pause();
      el._ttPaused = true;
      trace.to = el.currentTime;
      if (stalled) log("element-fail", { id, err: "stall" });
      clearTimeout(this.timer); this.timer = null; clearTimeout(startGuard);
      el.removeEventListener("playing", onPlaying); this.boundary = null;
      cb.onEnd && cb.onEnd();
    };
    const tick = () => {
      this.timer = null;
      if (s !== this.session) return;
      const now = el.currentTime, left = end - now;
      if (left <= 0.005) return finish(false);
      if (now !== lastTime){ lastTime = now; movedAt = performance.now(); }
      else if (performance.now() - movedAt > STALL_MS) return finish(true);
      if (gate && !el.paused && left > 0.05){
        const c = this.ctx, g = gate.gain;
        g.cancelScheduledValues(c.currentTime);
        g.setValueAtTime(1, c.currentTime);
        g.setValueAtTime(0, c.currentTime + left);
      }
      this.timer = setTimeout(tick, left > 0.4 ? Math.min(250, left * 1000 - 150) : Math.max(1, left * 1000 - 2));
    };
    const onPlaying = () => {
      if (s !== this.session) return;
      if (!started){
        started = true;
        clearTimeout(startGuard);
        movedAt = performance.now();
        trace.from = el.currentTime;
        cb.onStart && cb.onStart();
      }
      if (!this.timer) tick();
    };
    try { const t = (window.__ttClips ||= []); t.push(trace); if (t.length > 40) t.shift(); } catch(e){} // E2E/debug surface
    el.addEventListener("playing", onPlaying);
    this.boundary = onPlaying;
    startGuard = setTimeout(() => {
      if (s !== this.session || started) return;
      log("element-fail", { id, err: "no start" });
      this.stop();
      cb.onErr && cb.onErr();
    }, STALL_MS);
  },
  _play(el, s, id, onBlocked, onErr){
    const p = el.play();
    if (p) p.catch(e => {
      if (s !== this.session) return;
      log(e?.name === "NotAllowedError" ? "play-blocked" : "element-fail", { id, err:errMsg(e) });
      this.stop();
      if (e?.name === "NotAllowedError") onBlocked && onBlocked();
      else onErr && onErr();
    });
  },
  /* Light prefetch: a preload="auto" element for the next track, at most one.
     It never plays; playSnippet/playElement adopt it when the URL matches.
     `plain` marks a track that will play as-is (Easy), which must not
     be a CORS element or playElement would refetch it. */
  prefetch(track, plain){
    if (!track || !track.stream) return;
    const url = track.stream;
    if ((this.el && this.el.dataset.src === url) || (this.pre && this.pre.dataset.src === url)) return;
    if (this.pre){ try { this.pre.removeAttribute("src"); this.pre.load(); } catch(e){} } // cancel the old one
    const el = new Audio();
    const cors = !plain;
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
    if (!plain && !track.snip) return;
    const el = this._el(track.stream, !plain);
    const s = this.session;
    el.muted = true;
    const restore = () => { if (s === this.session) el.pause(); el.muted = false; };
    try { const p = el.play(); if (p) p.then(restore, restore); else restore(); } catch(e){ restore(); }
  },
  /* As-is playback (mode "plain"): reveals and Easy snippets.
     secs=0 plays to the end of the stream.
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
      // A continuation picks up exactly where the last clip paused (the few ms
      // it ran past its end were heard). The seek is needed even then:
      // Chromium resumes a paused element ~60ms past its pause point otherwise.
      const at = el.currentTime - offset;
      try { el.currentTime = at >= -0.02 && at <= 0.3 ? el.currentTime : offset; } catch(e){}
      el.muted = false;
      if (secs) this._clip(el, s, url.slice(-24), offset + secs, null, cb);
      this._play(el, s, url.slice(-24), cb.onBlocked, cb.onErr);
      this._mark("plain");
      if (!secs) cb.onStart && cb.onStart();
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
