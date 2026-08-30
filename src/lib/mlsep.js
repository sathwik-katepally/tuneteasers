/* Browser-side ML vocal separation (UVR MDX-Net instrumental model).
   Runs on WebGPU via onnxruntime-web; the model (~64MB) is fetched from
   Hugging Face's CDN on first use and kept in the browser's Cache API, so the
   site itself hosts no model and no audio. Devices without WebGPU — or ones
   that prove too slow — are remembered and skip ML, falling back to the DSP
   chain. All of this is best-effort: every failure path throws and the engine
   falls back gracefully. */
import { separateInstrumental } from "./mdx.js";

const MODEL_URL = "https://huggingface.co/Eddycrack864/UVR5-MDX-NET-VIP-MODELS/resolve/main/UVR-MDX-NET-Inst_full_292.onnx";
const ORT_VERSION = "1.29.0"; // must match package.json exactly (CDN wasm paths)
const LS_ML_SLOW = "tt_ml_slow";

let sessionP = null;

export function mlAvailable(){
  try {
    if (!("gpu" in navigator)) return false;
    if (localStorage.getItem(LS_ML_SLOW) === "1") return false;
    return true;
  } catch(e){ return false; }
}

async function fetchModel(){
  try {
    const c = await caches.open("tt-models");
    const hit = await c.match(MODEL_URL);
    if (hit) return await hit.arrayBuffer();
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error("model fetch " + r.status);
    const clone = r.clone();
    const buf = await r.arrayBuffer();
    c.put(MODEL_URL, clone).catch(()=>{});
    return buf;
  } catch(e){ // Cache API unavailable (private mode etc.) — plain fetch
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error("model fetch " + r.status);
    return await r.arrayBuffer();
  }
}

function getSession(){
  if (!sessionP){
    sessionP = (async () => {
      const ort = await import("onnxruntime-web/webgpu");
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      const model = await fetchModel();
      const session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"] });
      return { ort, session };
    })();
    sessionP.catch(()=>{ sessionP = null; }); // allow a retry after transient failures
  }
  return sessionP;
}

/* Start loading the model/session in the background (call at game start). */
export function warmup(){ if (mlAvailable()) getSession().catch(()=>{}); }

if (typeof window !== "undefined") window.__ttSep = { mlAvailable: () => mlAvailable(), separate: (b, c) => separateBuffer(b, c) }; // DSP/ML E2E hook

/* The model is trained on 44.1kHz audio; feed it anything else (48kHz contexts
   are common) and every frequency it learned shifts. Resample around inference. */
const MODEL_RATE = 44100;
async function resample(buf, rate){
  if (buf.sampleRate === rate) return buf;
  const len = Math.ceil(buf.duration * rate);
  const oc = new OfflineAudioContext(2, len, rate);
  const src = oc.createBufferSource(); src.buffer = buf;
  src.connect(oc.destination); src.start();
  return await oc.startRendering();
}

/* Returns a new AudioBuffer holding the instrumental of `buf`.
   The inference budget excludes the one-time model download; blowing the
   budget marks this device as too slow so future games skip ML instantly. */
export async function separateBuffer(buf, ctx, budgetMs = 75000){
  const { ort, session } = await getSession();
  const playRate = buf.sampleRate;
  buf = await resample(buf, MODEL_RATE);
  const chL = buf.getChannelData(0);
  const chR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : chL;
  const t0 = performance.now();
  const runFn = async (data, dims) => {
    if (performance.now() - t0 > budgetMs){
      try { localStorage.setItem(LS_ML_SLOW, "1"); } catch(e){}
      throw new Error("ml budget exceeded");
    }
    const res = await session.run({ input: new ort.Tensor("float32", data, dims) });
    return res.output.data;
  };
  const { outL, outR } = await separateInstrumental(chL, chR, runFn);
  const out = ctx.createBuffer(2, buf.length, MODEL_RATE); // createBuffer accepts any rate
  out.copyToChannel(outL, 0);
  out.copyToChannel(outR, 1);
  return await resample(out, playRate);
}
