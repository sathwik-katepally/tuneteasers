/* Singing-voice detection worker: essentia.js mel extraction + MusiCNN
   voice/instrumental classifier (3MB, self-hosted) on the tfjs WASM backend.
   Input: { pcm } — 16kHz mono Float32Array of the whole song (transferred).
   Output: { probs, hopSec } — p(voice) per ~3s patch — or { error }.
   Heavy imports stay in this worker so the main bundle pays nothing. */
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import { EssentiaTFInputExtractor, TensorflowMusiCNN } from "essentia.js/dist/essentia.js-model.es.js";

const MODEL_SR = 16000;
const PATCH_FRAMES = 187, MEL_HOP = 256; // MusiCNN input geometry
const PATCH_STRIDE = 2; // score every 2nd patch: inference dominates cost, 6s granularity is plenty
let ready = null;

function init(base){
  if (!ready){
    ready = (async () => {
      setWasmPaths(base + "tfjs/");
      await tf.setBackend("wasm");
      await tf.ready();
      const model = new TensorflowMusiCNN(tf, base + "models/voice_instrumental/model.json", false);
      await model.initialize();
      return { model };
    })();
    ready.catch(() => { ready = null; }); // allow retry after a transient failure
  }
  return ready;
}

self.onmessage = async ev => {
  const { pcm, base, seq, warm } = ev.data;
  if (warm){ init(base).catch(() => {}); return; } // preload model during crate build
  try {
    const { model } = await init(base);
    // The extraction leaks WASM heap in proportion to the frames it touches
    // (per-frame vectors essentia never frees), so mel is computed only for
    // the patches actually scored: one sample-aligned segment per kept patch,
    // which yields frames bit-identical to a full-song pass. A fresh extractor
    // per job, as reusing one corrupts the essentia heap after a few songs
    // (observed: "Out of bounds memory access", then aborts).
    const extractor = new EssentiaTFInputExtractor(EssentiaWASM, "musicnn", false);
    const segSamples = PATCH_FRAMES * MEL_HOP + MEL_HOP; // one extra hop: frame f covers [(f-1)*hop, (f-1)*hop + 2*hop)
    const kept = [];
    let features = null;
    try {
      // FrameGenerator centers its first frame (a hop of leading zeros), so a
      // segment starting one hop before patch p's first frame reproduces the
      // full-song frames exactly once that centered frame 0 is skipped.
      for (let p = 0; ; p++){
        const f0 = p * PATCH_STRIDE * PATCH_FRAMES; // patch p's first frame index in the full song
        const s = f0 === 0 ? 0 : (f0 - 1) * MEL_HOP;
        const skip = f0 === 0 ? 0 : 1;
        if (s + segSamples > pcm.length) break;
        features = extractor.computeFrameWise(pcm.subarray(s, s + segSamples), MEL_HOP);
        for (let i = 0; i < PATCH_FRAMES; i++) kept.push(features.melSpectrum[skip + i]);
      }
      if (!kept.length){ // very short song: keep whatever there is
        features = extractor.computeFrameWise(pcm, MEL_HOP);
        kept.push(...features.melSpectrum);
      }
    } finally { try { extractor.delete(); } catch(e){} }
    const acts = await model.predict({ ...features, melSpectrum: kept, frameSize: kept.length }, true); // [p_instrumental, p_voice] per patch
    const probs = Float32Array.from(acts.map(a => a[1]));
    const hopSec = (PATCH_FRAMES * MEL_HOP * PATCH_STRIDE) / MODEL_SR; // ~6s per kept patch
    self.postMessage({ seq, probs, hopSec }, [probs.buffer]);
  } catch (e){
    self.postMessage({ seq, error: String((e && e.message) || e).slice(0, 200) });
  }
};
