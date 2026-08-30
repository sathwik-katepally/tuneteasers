/* Audio engine — the ONLY owner of playback.
   Every action bumps `session`. Any async continuation from an older session
   is ignored, so two songs can never play at once. */
export const engine = {
  ctx:null, el:null, srcNode:null, timer:null, session:0,
  cache:{ url:null, buf:null },
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
  trim(buf, secs){
    const c = this.ac();
    const len = Math.min(buf.length, Math.floor(secs * buf.sampleRate));
    const nb = c.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
    for (let ch=0; ch<buf.numberOfChannels; ch++) nb.copyToChannel(buf.getChannelData(ch).subarray(0,len), ch);
    return nb;
  },
  async ensureBuf(url){
    if (this.cache.url === url && this.cache.buf) return this.cache.buf;
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    const full = await this.ac().decodeAudioData(ab);
    const buf = this.trim(full, 45);
    this.cache = { url, buf };
    return buf;
  },
  prefetch(url){ if (url) this.ensureBuf(url).catch(()=>{}); },
  /* returns "played" | "failed" | "superseded" */
  async playMuffled(url, offset, secs, onEnd){
    this.stop();
    const s = this.session;
    let buf;
    try { buf = await this.ensureBuf(url); } catch(e){ return (s===this.session) ? "failed" : "superseded"; }
    if (s !== this.session) return "superseded";
    if (offset >= buf.duration - 1) return "failed";
    const c = this.ac();
    const src = c.createBufferSource(); src.buffer = buf;
    const out = c.createGain();
    const lp = c.createBiquadFilter(); lp.type="lowpass"; lp.frequency.value=140;
    const lpG = c.createGain(); lpG.gain.value=0.9;
    src.connect(lp); lp.connect(lpG); lpG.connect(out);
    let mainIn;
    if (buf.numberOfChannels >= 2){
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
    out.connect(c.destination);
    src.start(0, offset, secs);
    this.srcNode = src;
    this.timer = setTimeout(()=>{ if (s === this.session) onEnd && onEnd(); }, secs*1000);
    return "played";
  },
  playElement(url, offset, secs, onEnd){
    this.stop();
    const s = this.session;
    if (!this.el || this.el.dataset.src !== url){
      this.el = new Audio(url);
      this.el.preload = "auto";
      this.el.dataset.src = url;
    }
    const el = this.el;
    const go = () => {
      if (s !== this.session) return; // superseded while loading — never plays
      try { el.currentTime = offset; } catch(e){}
      const p = el.play(); if (p) p.catch(()=>{});
      if (secs) this.timer = setTimeout(()=>{ if (s === this.session){ el.pause(); onEnd && onEnd(); } }, secs*1000);
    };
    if (el.readyState >= 1) go();
    else el.addEventListener("loadedmetadata", go, { once:true });
  },
};

let wakeLock = null;
export async function keepAwake(on){
  try {
    if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock){ wakeLock.release(); wakeLock = null; }
  } catch(e){}
}
