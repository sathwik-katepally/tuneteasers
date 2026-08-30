/* Center-channel suppression ("centercut") — the vocal reducer.
   Runs offline on the decoded AudioBuffer before playback.
   For each STFT bin, content that is nearly identical in both channels
   (center-panned — almost always the lead vocal) is attenuated; panned and
   uncorrelated content (most instruments, reverb) passes through, so the
   music keeps its stereo image. A plain L−R karaoke trick collapses to mono
   and deletes every centered instrument; this per-bin soft mask is gentler,
   and it is band-limited so bass/kick (also center-panned) and air survive.
   FFT comes from fft.js; only the masking logic here is ours. */
import FFT from "fft.js";

export const CENTERCUT = {
  fftSize: 2048,
  loHz: 180,   // below this the mix passes untouched (kick and bass sit center too)
  hiHz: 9000,  // above this the mix passes untouched
  gainFloor: 0.18,            // max suppression for perfectly centered bins (~ -15dB)
  simLo: 0.15, simHi: 0.55,   // side-similarity thresholds shaping the soft mask
};

export async function centerCut(buf, ctx, opts = CENTERCUT){
  if (buf.numberOfChannels < 2) return buf;
  const n = opts.fftSize, hop = n>>1, sr = buf.sampleRate, len = buf.length;
  const fft = new FFT(n);
  // sqrt-Hann on analysis AND synthesis: their product is Hann, which sums to 1 at 50% overlap
  const win = new Float32Array(n);
  for (let i=0;i<n;i++) win[i] = Math.sqrt(0.5 - 0.5*Math.cos(2*Math.PI*i/n));
  const inL = buf.getChannelData(0), inR = buf.getChannelData(1);
  const outL = new Float32Array(len), outR = new Float32Array(len);
  const frameL = new Float64Array(n), frameR = new Float64Array(n);
  const specL = fft.createComplexArray(), specR = fft.createComplexArray();
  const timeL = fft.createComplexArray(), timeR = fft.createComplexArray();
  const kLo = Math.max(1, Math.round(opts.loHz*n/sr));
  const kHi = Math.min(n>>1, Math.round(opts.hiHz*n/sr));
  const gPrev = new Float32Array(n>>1).fill(1);
  let frame = 0;
  for (let pos = -hop; pos < len; pos += hop, frame++){
    for (let i=0;i<n;i++){
      const p = pos+i, w = win[i];
      const inside = p>=0 && p<len;
      frameL[i] = inside ? inL[p]*w : 0;
      frameR[i] = inside ? inR[p]*w : 0;
    }
    fft.realTransform(specL, frameL); fft.completeSpectrum(specL);
    fft.realTransform(specR, frameR); fft.completeSpectrum(specR);
    for (let k=kLo;k<kHi;k++){
      const i2 = 2*k;
      const reL=specL[i2], imL=specL[i2+1], reR=specR[i2], imR=specR[i2+1];
      const mL = Math.hypot(reL,imL), mR = Math.hypot(reR,imR);
      const s = Math.hypot(reL-reR, imL-imR) / (mL+mR+1e-9); // 0 = identical (center), 1 = fully panned
      let t = (s - opts.simLo) / (opts.simHi - opts.simLo);
      t = t<0 ? 0 : t>1 ? 1 : t;
      t = t*t*(3-2*t);
      let g = opts.gainFloor + (1-opts.gainFloor)*t;
      g = 0.5*g + 0.5*gPrev[k]; gPrev[k] = g; // temporal smoothing against musical noise
      const j2 = 2*(n-k); // conjugate-mirror bin keeps the signal real
      specL[i2]*=g; specL[i2+1]*=g; specR[i2]*=g; specR[i2+1]*=g;
      specL[j2]*=g; specL[j2+1]*=g; specR[j2]*=g; specR[j2+1]*=g;
    }
    fft.inverseTransform(timeL, specL);
    fft.inverseTransform(timeR, specR);
    for (let i=0;i<n;i++){
      const p = pos+i;
      if (p<0 || p>=len) continue;
      const w = win[i];
      outL[p] += timeL[2*i]*w;
      outR[p] += timeR[2*i]*w;
    }
    if ((frame & 127) === 127) await new Promise(r=>setTimeout(r,0)); // keep the UI responsive
  }
  const out = ctx.createBuffer(2, len, sr);
  out.copyToChannel(outL, 0); out.copyToChannel(outR, 1);
  return out;
}

if (typeof window !== "undefined") window.__ttCenterCut = centerCut; // exercised by the DSP E2E test
