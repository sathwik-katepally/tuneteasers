/* Dynamic snippet selection — find where the song is instrumental instead of
   trying to erase vocals. Every threshold below adapts to the song at hand:
   frames are scored for vocal activity, and the window choice, the silence
   guard, and the "clean enough to play raw" call are all made against THIS
   song's own score/energy distribution, never fixed absolute levels. */
import FFT from "fft.js";

export const SNIPPICK = {
  fftSize: 2048,
  loHz: 200, hiHz: 4000, // where singing lives
  windowSec: 25,         // desired stretch: snippet plus replay/extend headroom
};

/* Per-frame vocal-activity score in [0,1]: the fraction of vocal-band energy
   that is center-correlated (lead vocals sit dead center; instruments and
   reverb spread wider). Also returns per-frame energy for the silence guard. */
async function vocalProfile(buf){
  const n = SNIPPICK.fftSize, hop = n>>1, sr = buf.sampleRate, len = buf.length;
  const fft = new FFT(n);
  const win = new Float32Array(n);
  for (let i=0;i<n;i++) win[i] = 0.5 - 0.5*Math.cos(2*Math.PI*i/n);
  const inL = buf.getChannelData(0), inR = buf.getChannelData(1);
  const frameL = new Float64Array(n), frameR = new Float64Array(n);
  const specL = fft.createComplexArray(), specR = fft.createComplexArray();
  const kLo = Math.max(1, Math.round(SNIPPICK.loHz*n/sr));
  const kHi = Math.min(n>>1, Math.round(SNIPPICK.hiHz*n/sr));
  const nF = Math.max(1, Math.floor(len/hop));
  const scores = new Float32Array(nF), energies = new Float32Array(nF);
  for (let f=0; f<nF; f++){
    const pos = f*hop;
    for (let i=0;i<n;i++){
      const p = pos+i, inside = p<len, w = win[i];
      frameL[i] = inside ? inL[p]*w : 0;
      frameR[i] = inside ? inR[p]*w : 0;
    }
    fft.realTransform(specL, frameL);
    fft.realTransform(specR, frameR);
    let wsum = 0, msum = 0;
    for (let k=kLo;k<kHi;k++){
      const i2 = 2*k;
      const reL=specL[i2], imL=specL[i2+1], reR=specR[i2], imR=specR[i2+1];
      const mL = Math.hypot(reL,imL), mR = Math.hypot(reR,imR);
      const m = mL+mR;
      const s = Math.hypot(reL-reR, imL-imR) / (m+1e-9);
      const center = 1-s < 0 ? 0 : 1-s;
      wsum += m*center*center;
      msum += m;
    }
    scores[f] = msum > 1e-6 ? wsum/msum : 0;
    energies[f] = msum;
    if ((f & 255) === 255) await new Promise(r=>setTimeout(r,0));
  }
  return { scores, energies, hop, sr };
}

/* Returns { start, clean }: the offset (seconds) of the most instrumental
   window, and whether it is clean enough — by this song's own standards —
   to play raw with no vocal processing at all. */
export async function pickSnippetWindow(buf){
  if (buf.numberOfChannels < 2 || buf.duration < 12) return { start: 0, clean: false };
  const { scores, energies, hop, sr } = await vocalProfile(buf);
  const nF = scores.length;
  // Near-silent frames (relative to this song) are as bad as vocal ones:
  // a snippet of silence teases nothing.
  const eMed = Float32Array.from(energies).sort()[nF>>1];
  const eff = new Float32Array(nF);
  for (let i=0;i<nF;i++) eff[i] = energies[i] < eMed*0.12 ? 0.8 : scores[i];
  const winF = Math.max(1, Math.min(nF, Math.round(SNIPPICK.windowSec*sr/hop)));
  const prefix = new Float64Array(nF+1);
  for (let i=0;i<nF;i++) prefix[i+1] = prefix[i] + eff[i];
  let bestIdx = 0, bestMean = Infinity;
  for (let i=0; i+winF<=nF; i++){
    const mean = (prefix[i+winF]-prefix[i])/winF + 0.02*(i/nF); // near-ties go to earlier sections
    if (mean < bestMean){ bestMean = mean; bestIdx = i; }
  }
  const meanBest = (prefix[bestIdx+winF]-prefix[bestIdx])/winF;
  // Conservative verdict, used only when ML separation is unavailable: raw
  // playback needs the window clearly below this song's own typical level AND
  // a profile with real contrast. A flat profile proves nothing — wide/doubled
  // vocals score low everywhere and are indistinguishable from instruments
  // here — so flat songs are never trusted as clean (they get the muffle).
  const sorted = Float32Array.from(eff).sort();
  const p20 = sorted[Math.floor(nF*0.2)], p80 = sorted[Math.floor(nF*0.8)];
  const clean = (p80 - p20 >= 0.12) && meanBest < p20 + 0.15*(p80 - p20);
  return { start: bestIdx*hop/sr, clean };
}

if (typeof window !== "undefined") window.__ttPick = pickSnippetWindow; // exercised by the DSP E2E test
