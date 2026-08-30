/* MDX-Net inference plumbing — STFT, chunking, and iSTFT around the ONNX model,
   matching UVR's conventions exactly (n_fft 6144, hop 1024, dim_f 3072, dim_t 256,
   Hann windows, centered frames with reflect padding, edge-trimmed chunks).
   Pure JS and runtime-agnostic: the caller supplies `runFn` (onnxruntime-web in
   the browser, onnxruntime-node in tests), so this file is testable off-page.
   n_fft 6144 = 3·2048 is not a power of two, so the FFT is mixed-radix:
   three interleaved 2048-point fft.js transforms plus one radix-3 combine. */
import FFT from "fft.js";

export const MDX = { nFft: 6144, hop: 1024, dimF: 3072, dimT: 256 };

function makeFFT6144(){
  const N = 6144, M = 2048;
  const f = new FFT(M);
  const a = f.createComplexArray(), b = f.createComplexArray(), c = f.createComplexArray();
  const A = f.createComplexArray(), B = f.createComplexArray(), C = f.createComplexArray();
  const tw = new Float64Array(2*N); // e^(-2πik/N)
  for (let k=0;k<N;k++){ tw[2*k] = Math.cos(2*Math.PI*k/N); tw[2*k+1] = -Math.sin(2*Math.PI*k/N); }
  /* forward complex FFT of size 6144, interleaved in/out */
  function fwd(inp, out){
    for (let n=0;n<M;n++){
      a[2*n]=inp[2*(3*n)];   a[2*n+1]=inp[2*(3*n)+1];
      b[2*n]=inp[2*(3*n+1)]; b[2*n+1]=inp[2*(3*n+1)+1];
      c[2*n]=inp[2*(3*n+2)]; c[2*n+1]=inp[2*(3*n+2)+1];
    }
    f.transform(A, a); f.transform(B, b); f.transform(C, c);
    for (let k=0;k<N;k++){
      const kk = k & (M-1);
      const w1r = tw[2*k], w1i = tw[2*k+1];
      const k2 = (2*k) % N;
      const w2r = tw[2*k2], w2i = tw[2*k2+1];
      const br = B[2*kk], bi = B[2*kk+1], cr = C[2*kk], ci = C[2*kk+1];
      out[2*k]   = A[2*kk]   + w1r*br - w1i*bi + w2r*cr - w2i*ci;
      out[2*k+1] = A[2*kk+1] + w1r*bi + w1i*br + w2r*ci + w2i*cr;
    }
  }
  /* inverse via conjugation: ifft(X) = conj(fft(conj(X)))/N */
  function inv(inp, out){
    for (let k=0;k<N;k++){ out[2*k] = inp[2*k]; out[2*k+1] = -inp[2*k+1]; }
    const tmp = new Float64Array(2*N);
    fwd(out, tmp);
    for (let n=0;n<N;n++){ out[2*n] = tmp[2*n]/N; out[2*n+1] = -tmp[2*n+1]/N; }
  }
  return { fwd, inv };
}

/* Separate one stereo clip into its instrumental. runFn(Float32Array, [1,4,dimF,dimT])
   must return the model's output Float32Array of the same shape. */
export async function separateInstrumental(chL, chR, runFn, onProgress){
  const { nFft, hop, dimF, dimT } = MDX;
  const trim = nFft >> 1;                 // model output edges are unreliable; discard them
  const chunkSize = hop * (dimT - 1);     // exactly dimT centered frames per chunk
  const genSize = chunkSize - 2*trim;     // fresh samples produced per chunk
  const nSample = chL.length;
  const pad = genSize - (nSample % genSize || genSize);
  const padded = nSample + pad + 2*trim;
  const mixL = new Float32Array(padded), mixR = new Float32Array(padded);
  mixL.set(chL, trim); mixR.set(chR, trim);
  const outL = new Float32Array(nSample), outR = new Float32Array(nSample);

  const fft = makeFFT6144();
  const win = new Float64Array(nFft);
  for (let i=0;i<nFft;i++) win[i] = 0.5 - 0.5*Math.cos(2*Math.PI*i/nFft); // periodic Hann, as torch
  const half = nFft >> 1;
  const frame = new Float64Array(2*nFft), spec = new Float64Array(2*nFft);
  const tensor = new Float32Array(4*dimF*dimT);
  const wsum = new Float64Array(chunkSize + nFft);
  const acc = [new Float64Array(chunkSize + nFft), new Float64Array(chunkSize + nFft)];

  const nChunks = Math.ceil((nSample + pad) / genSize);
  for (let ci=0; ci<nChunks; ci++){
    const base = ci * genSize; // chunk covers padded[base, base+chunkSize)
    // analysis: frame t is centered at chunk position t*hop; out-of-range reads are zeros
    for (let ch=0; ch<2; ch++){
      const mix = ch ? mixR : mixL;
      for (let t=0; t<dimT; t++){
        const from = base + t*hop - half;
        for (let i=0;i<nFft;i++){
          frame[2*i] = (mix[from + i] || 0) * win[i]; frame[2*i+1] = 0;
        }
        fft.fwd(frame, spec);
        const o = ch*2*dimF*dimT;
        for (let k=0;k<dimF;k++){
          tensor[o + k*dimT + t] = spec[2*k];
          tensor[o + dimF*dimT + k*dimT + t] = spec[2*k+1];
        }
      }
    }
    const out = await runFn(tensor, [1, 4, dimF, dimT]);
    // synthesis: weighted overlap-add with window-square normalization (as torch.istft).
    // Accumulator index q = chunk position + half (so frame t spans q = t*hop .. t*hop+nFft-1).
    acc[0].fill(0); acc[1].fill(0); wsum.fill(0);
    for (let ch=0; ch<2; ch++){
      const o = ch*2*dimF*dimT;
      for (let t=0; t<dimT; t++){
        for (let k=0;k<dimF;k++){
          spec[2*k] = out[o + k*dimT + t];
          spec[2*k+1] = out[o + dimF*dimT + k*dimT + t];
        }
        for (let k=dimF;k<=half;k++){ spec[2*k]=0; spec[2*k+1]=0; }     // bins the model doesn't cover
        for (let k=1;k<half;k++){ spec[2*(nFft-k)] = spec[2*k]; spec[2*(nFft-k)+1] = -spec[2*k+1]; }
        fft.inv(spec, frame);
        for (let i=0;i<nFft;i++){
          const q = t*hop + i;
          acc[ch][q] += frame[2*i]*win[i];
          if (ch === 0) wsum[q] += win[i]*win[i];
        }
      }
    }
    // keep only the trustworthy middle of the chunk; padded position base+i maps to sample base+i-trim
    for (let i=trim; i<chunkSize-trim; i++){
      const dst = base + i - trim;
      if (dst >= nSample) break;
      const w = wsum[i + half] || 1;
      outL[dst] = acc[0][i + half] / w;
      outR[dst] = acc[1][i + half] / w;
    }
    if (onProgress) onProgress((ci+1)/nChunks);
    await new Promise(r=>setTimeout(r,0)); // yield between chunks
  }
  return { outL, outR };
}
