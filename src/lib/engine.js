/* Audio engine — the ONLY owner of playback.
   Every action bumps `session`. Any async continuation from an older session
   is ignored, so two songs can never play at once. */
import { centerCut } from "./centercut.js";
import { pickSnippetWindow } from "./snippick.js";
import { mlAvailable, separateBuffer } from "./mlsep.js";

/* Post-centercut shaping: the lead vocal is already ducked, so only dull the leakage. */
function buildMildGraph(c, src){
  const lp = c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=7000;
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
  cache: new Map(), // url -> Promise<{ buf, cut }> for the current and prefetched tracks
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
  ensureBuf(url){
    let p = this.cache.get(url);
    if (!p){
      p = this._load(url);
      this.cache.set(url, p);
      if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
      p.catch(()=>{ if (this.cache.get(url) === p) this.cache.delete(url); }); // never cache failures
    }
    return p;
  },
  async _load(url){
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    const full = await this.ac().decodeAudioData(ab);
    // Pick the most instrumental stretch, then ALWAYS run ML separation on it
    // when this device can: the vocal-activity detector is only a heuristic
    // (wide/doubled vocals evade it), so it chooses the window but never gets
    // to skip separation. Raw playback without ML needs a truly clean verdict.
    const done = r => { try { window.__ttLastMode = r.mode; } catch(e){} return r; }; // E2E/debug surface
    let start = 0, clean = false;
    try { ({ start, clean } = await pickSnippetWindow(full)); } catch(e){}
    let buf = this.slice(full, start, 45);
    if (mlAvailable()){
      try { return done({ buf: await separateBuffer(buf, this.ac()), mode: "ml" }); } catch(e){}
    }
    if (clean) return done({ buf, mode: "raw" });
    let mode = "legacy";
    if (buf.numberOfChannels >= 2){
      try { buf = await centerCut(buf, this.ac()); mode = "cut"; } catch(e){}
    }
    return done({ buf, mode });
  },
  prefetch(url){ if (url) this.ensureBuf(url).catch(()=>{}); },
  /* returns "played" | "failed" | "superseded" */
  async playMuffled(url, offset, secs, onEnd){
    this.stop();
    const s = this.session;
    let entry;
    try { entry = await this.ensureBuf(url); } catch(e){ return (s===this.session) ? "failed" : "superseded"; }
    if (s !== this.session) return "superseded";
    const { buf, mode } = entry;
    if (offset >= buf.duration - 1) return "failed";
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
