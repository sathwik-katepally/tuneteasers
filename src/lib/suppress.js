/* Vocal suppression cascade — the DSP-path vocal reducer.
   Runs offline on the sliced AudioBuffer before playback. Three independent
   cues are combined, because each one alone fails on Bollywood/Telugu mixes:

   1. Center mask (spatial): bins with near-identical L/R content are ducked.
      Defeated by wide/doubled/reverbed leads — which is why it is not alone.
   2. REPET-SIM mask (repetition, Rafii & Pardo 2012 / FitzGerald 2012): for
      each frame, the per-bin median over its k most-similar OTHER frames
      models the repeating accompaniment; energy above that model is
      non-repeating — the lead vocal, however it is panned. Orthogonal to cue 1.
   3. HPSS percussive re-injection (Fitzgerald 2010): vocals are harmonic, so
      the percussive component is vocal-safe and is mixed back near full level,
      keeping the groove loud and perceptually burying vocal residue.

   The masks multiply (suppression adds in dB where both cues agree), the band
   reaches 14kHz so sibilants — the most lyric-revealing cues — are treated,
   and the floor deepens to ~-24dB in the 1-8kHz consonant region.
   FFT comes from fft.js; all masking logic here is ours. */
import FFT from "fft.js";

export const SUPPRESS = {
  fftSize: 2048,
  loHz: 180,    // below: untouched (kick/bass sit center too)
  hiHz: 14000,  // above: untouched (air)
  deepLoHz: 1000, deepHiHz: 8000, // consonant region gets the deeper floor
  floorBase: 0.18,  // ~-15dB max suppression outside the deep band
  floorDeep: 0.06,  // ~-24dB inside it
  simLo: 0.15, simHi: 0.55,       // center-mask similarity thresholds
  repK: 25,           // neighbors for the REPET-SIM median
  repExcludeSec: 2.5, // frames this close to t can contain the same held note/phrase
  repBands: 96,      // pooled similarity-feature bands (100Hz-8kHz)
  combinePow: 1.35,  // extra aggressiveness on the combined mask
  percKeep: 0.9,     // percussive re-injection level
  medT: 17, medF: 17, hpssMargin: 2, // HPSS median widths and Driedger margin
};

const yieldNow = () => new Promise(r => setTimeout(r, 0));

function medianOf(arr, len){ // arr is scratch: sort the view in place, no allocation
  const a = arr.subarray(0, len).sort();
  return a[len >> 1];
}

/* Per-frame magnitude spectrogram of the L/R average ("mid"), Float32 [T][half]. */
async function midSpectrogram(inL, inR, len, fft, win, n, hop){
  const half = n >> 1;
  const frame = new Float64Array(n);
  const spec = fft.createComplexArray();
  const T = Math.max(1, Math.ceil((len + hop) / hop));
  const V = new Float32Array(T * half);
  for (let t = 0; t < T; t++){
    const pos = t * hop - hop;
    for (let i = 0; i < n; i++){
      const p = pos + i;
      frame[i] = (p >= 0 && p < len) ? 0.5 * (inL[p] + inR[p]) * win[i] : 0;
    }
    fft.realTransform(spec, frame);
    const row = t * half;
    for (let k = 0; k < half; k++) V[row + k] = Math.hypot(spec[2*k], spec[2*k + 1]);
    if ((t & 127) === 127) await yieldNow();
  }
  return { V, T, half };
}

/* REPET-SIM: per-bin repeating-background gain in [0,1], Float32 [T][half]. */
async function repetMask(V, T, half, sr, n, hop, opts){
  // pooled log features for frame similarity (100Hz-8kHz)
  const bLo = Math.max(1, Math.round(100 * n / sr)), bHi = Math.min(half, Math.round(8000 * n / sr));
  const B = opts.repBands, span = bHi - bLo;
  const feat = new Float32Array(T * B);
  for (let t = 0; t < T; t++){
    const row = t * half, frow = t * B;
    for (let b = 0; b < B; b++){
      const k0 = bLo + Math.floor(b * span / B), k1 = bLo + Math.floor((b + 1) * span / B);
      let s = 0;
      for (let k = k0; k < k1; k++) s += V[row + k];
      feat[frow + b] = Math.log1p(s);
    }
    let norm = 0;
    for (let b = 0; b < B; b++) norm += feat[frow + b] * feat[frow + b];
    norm = Math.sqrt(norm) || 1;
    for (let b = 0; b < B; b++) feat[frow + b] /= norm;
  }
  const excl = Math.max(1, Math.round(opts.repExcludeSec * sr / hop));
  const K = opts.repK;
  const mask = new Float32Array(T * half);
  const simIdx = new Int32Array(T), simVal = new Float32Array(T);
  const nbr = new Float32Array(K + 1);
  // The similarity search is the O(T^2) hot spot: scoring every 2nd frame
  // (odd frames copy their neighbor's row below) against every 2nd candidate
  // quarters the work; 46ms mask granularity is inaudible after smoothing.
  for (let t = 0; t < T; t += 2){
    const frow = t * B;
    let m = 0;
    for (let u = 0; u < T; u += 2){
      if (Math.abs(u - t) <= excl) continue;
      const urow = u * B;
      let dot = 0;
      for (let b = 0; b < B; b++) dot += feat[frow + b] * feat[urow + b];
      simIdx[m] = u; simVal[m] = dot; m++;
    }
    // top-K by selection (K << m)
    const kUse = Math.min(K, m);
    for (let a = 0; a < kUse; a++){
      let best = a;
      for (let b2 = a + 1; b2 < m; b2++) if (simVal[b2] > simVal[best]) best = b2;
      const vi = simVal[a]; simVal[a] = simVal[best]; simVal[best] = vi;
      const ii = simIdx[a]; simIdx[a] = simIdx[best]; simIdx[best] = ii;
    }
    const row = t * half;
    for (let k = 0; k < half; k++){
      for (let a = 0; a < kUse; a++) nbr[a] = V[simIdx[a] * half + k];
      const bg = kUse ? medianOf(nbr, kUse) : V[row + k]; // repeating-background estimate
      const v = V[row + k];
      mask[row + k] = v > 1e-9 ? Math.min(1, Math.min(bg, v) / v) : 1;
    }
    if (t + 1 < T) mask.copyWithin((t + 1) * half, row, row + half);
    if ((t & 31) === 31) await yieldNow();
  }
  return mask;
}

/* HPSS percussive soft mask in [0,1], Float32 [T][half] (median filters + Wiener). */
async function percMask(V, T, half, opts){
  const mT = opts.medT >> 1, mF = opts.medF >> 1, mg = opts.hpssMargin;
  const mask = new Float32Array(T * half);
  const bufT = new Float32Array(opts.medT), bufF = new Float32Array(opts.medF);
  for (let t = 0; t < T; t++){
    const row = t * half;
    for (let k = 0; k < half; k++){
      let c = 0; // harmonic estimate: median across time at this bin
      for (let dt = -mT; dt <= mT; dt++){
        const u = t + dt;
        if (u >= 0 && u < T) bufT[c++] = V[u * half + k];
      }
      const harm = medianOf(bufT, c);
      c = 0;     // percussive estimate: median across frequency at this frame
      for (let dk = -mF; dk <= mF; dk++){
        const j = k + dk;
        if (j >= 0 && j < half) bufF[c++] = V[row + j];
      }
      const perc = medianOf(bufF, c);
      const p2 = perc * perc, h2 = mg * mg * harm * harm;
      mask[row + k] = perc > mg * harm ? p2 / (p2 + h2 + 1e-18) : 0; // margin gate, then Wiener
    }
    if ((t & 31) === 31) await yieldNow();
  }
  return mask;
}

export async function suppressVocals(buf, ctx, opts = SUPPRESS){
  if (buf.numberOfChannels < 2) return buf;
  const n = opts.fftSize, hop = n >> 1, sr = buf.sampleRate, len = buf.length, half = n >> 1;
  const fft = new FFT(n);
  // sqrt-Hann on analysis AND synthesis: their product is Hann, which sums to 1 at 50% overlap
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  const inL = buf.getChannelData(0), inR = buf.getChannelData(1);

  // Pass 1: mid magnitudes for the whole clip, then the two global masks.
  const { V, T } = await midSpectrogram(inL, inR, len, fft, win, n, hop);
  const rep = await repetMask(V, T, half, sr, n, hop, opts);
  const perc = await percMask(V, T, half, opts);

  // Pass 2: re-STFT per channel, combine per-bin gains, overlap-add back.
  const outL = new Float32Array(len), outR = new Float32Array(len);
  const frameL = new Float64Array(n), frameR = new Float64Array(n);
  const specL = fft.createComplexArray(), specR = fft.createComplexArray();
  const timeL = fft.createComplexArray(), timeR = fft.createComplexArray();
  const kLo = Math.max(1, Math.round(opts.loHz * n / sr));
  const kHi = Math.min(half, Math.round(opts.hiHz * n / sr));
  const dLo = Math.round(opts.deepLoHz * n / sr), dHi = Math.round(opts.deepHiHz * n / sr);
  const gPrev = new Float32Array(half).fill(1);
  for (let t = 0; t < T; t++){
    const pos = t * hop - hop;
    for (let i = 0; i < n; i++){
      const p = pos + i, w = win[i];
      const inside = p >= 0 && p < len;
      frameL[i] = inside ? inL[p] * w : 0;
      frameR[i] = inside ? inR[p] * w : 0;
    }
    fft.realTransform(specL, frameL); fft.completeSpectrum(specL);
    fft.realTransform(specR, frameR); fft.completeSpectrum(specR);
    const row = t * half;
    for (let k = kLo; k < kHi; k++){
      const i2 = 2 * k;
      const reL = specL[i2], imL = specL[i2+1], reR = specR[i2], imR = specR[i2+1];
      const mL = Math.hypot(reL, imL), mR = Math.hypot(reR, imR);
      const s = Math.hypot(reL - reR, imL - imR) / (mL + mR + 1e-9); // 0 = center, 1 = panned
      let tt = (s - opts.simLo) / (opts.simHi - opts.simLo);
      tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
      tt = tt * tt * (3 - 2 * tt);
      const floor = (k >= dLo && k < dHi) ? opts.floorDeep : opts.floorBase;
      const gCenter = floor + (1 - floor) * tt; // center mask may dive to the local floor
      let g = Math.pow(gCenter * rep[row + k], opts.combinePow);
      g = Math.max(g, floor);
      g = Math.max(g, opts.percKeep * perc[row + k]); // drums pass nearly untouched
      g = 0.5 * g + 0.5 * gPrev[k]; gPrev[k] = g;     // temporal smoothing against musical noise
      const j2 = 2 * (n - k); // conjugate-mirror bin keeps the signal real
      specL[i2] *= g; specL[i2+1] *= g; specR[i2] *= g; specR[i2+1] *= g;
      specL[j2] *= g; specL[j2+1] *= g; specR[j2] *= g; specR[j2+1] *= g;
    }
    fft.inverseTransform(timeL, specL);
    fft.inverseTransform(timeR, specR);
    for (let i = 0; i < n; i++){
      const p = pos + i;
      if (p < 0 || p >= len) continue;
      const w = win[i];
      outL[p] += timeL[2*i] * w;
      outR[p] += timeR[2*i] * w;
    }
    if ((t & 63) === 63) await yieldNow();
  }
  const out = ctx.createBuffer(2, len, sr);
  out.copyToChannel(outL, 0); out.copyToChannel(outR, 1);
  return out;
}

if (typeof window !== "undefined") window.__ttSuppress = suppressVocals; // exercised by the DSP E2E test
