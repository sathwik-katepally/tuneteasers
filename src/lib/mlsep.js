/* Browser-side ML vocal separation (UVR MDX-Net instrumental model).
   Runs on WebGPU via onnxruntime-web; the model (~64MB) is fetched from
   Hugging Face's CDN on first use and kept in the browser's Cache API, so the
   site itself hosts no model and no audio. Devices without WebGPU — or ones
   that prove too slow — are remembered and skip ML, falling back to the DSP
   chain. All of this is best-effort: every failure path throws and the engine
   falls back gracefully. */
import { separateInstrumental } from "./mdx.js";
import { log, ms, errMsg } from "./log.js";

// Public (non-VIP) UVR model; params: n_fft 6144, dim_f 3072, dim_t 256, primary stem Instrumental
const MODEL_URL = "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Inst_HQ_3.onnx";
const ORT_VERSION = "1.29.0"; // must match package.json exactly (CDN wasm paths)
const LS_ML_SLOW = "tt_ml_slow";

let sessionP = null;

/* iOS Safari enforces tight per-tab memory limits: the model download + WebGPU
   session on top of a decoded full song gets the tab jetsam-killed, which
   reloads the page mid-game (seen as "Cueing it up… then back to the home
   page"). The DSP centercut path is the reliable one there. iPadOS reports
   itself as MacIntel, hence the maxTouchPoints check. */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* Why this device does or doesn't run ML — logged once per page load. */
export function mlReason(){
  try {
    if (IS_IOS) return "ios";
    if (!("gpu" in navigator)) return "no-webgpu";
    if (localStorage.getItem(LS_ML_SLOW) === "1") return "slow-flag";
    return "ok";
  } catch(e){ return "error"; }
}
export function mlAvailable(){ return mlReason() === "ok"; }

async function fetchModel(){
  const t0 = performance.now();
  try {
    const c = await caches.open("tt-models");
    const hit = await c.match(MODEL_URL);
    if (hit){
      const buf = await hit.arrayBuffer();
      log("ml-model", { from: "cache", mb: Math.round(buf.byteLength/1048576), ms: ms(t0) });
      return buf;
    }
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error("model fetch " + r.status);
    const clone = r.clone();
    const buf = await r.arrayBuffer();
    c.put(MODEL_URL, clone).catch(()=>{});
    log("ml-model", { from: "download", mb: Math.round(buf.byteLength/1048576), ms: ms(t0) });
    return buf;
  } catch(e){ // Cache API unavailable (private mode etc.) — plain fetch
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error("model fetch " + r.status);
    const buf = await r.arrayBuffer();
    log("ml-model", { from: "download-nocache", mb: Math.round(buf.byteLength/1048576), ms: ms(t0) });
    return buf;
  }
}

function getSession(){
  if (!sessionP){
    sessionP = (async () => {
      const ort = await import("onnxruntime-web/webgpu");
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      const model = await fetchModel();
      const t0 = performance.now();
      const session = await ort.InferenceSession.create(model, { executionProviders: ["webgpu"] });
      log("ml-session", { ms: ms(t0) });
      return { ort, session };
    })();
    sessionP.catch(e => { log("ml-session-fail", { msg: errMsg(e) }); sessionP = null; }); // allow a retry after transient failures
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
  let chL = buf.getChannelData(0);
  let chR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : chL;
  // match UVR's preprocessing: peaks above 0.9 are scaled down before inference
  let peak = 0;
  for (let i=0;i<chL.length;i++){ const a = Math.abs(chL[i]), b = Math.abs(chR[i]); if (a>peak) peak=a; if (b>peak) peak=b; }
  const scale = peak > 0.9 ? 0.9/peak : 1;
  if (scale !== 1){
    const sL = new Float32Array(chL.length), sR = new Float32Array(chR.length);
    for (let i=0;i<chL.length;i++){ sL[i]=chL[i]*scale; sR[i]=chR[i]*scale; }
    chL = sL; chR = sR;
  }
  const t0 = performance.now();
  const runFn = async (data, dims) => {
    if (performance.now() - t0 > budgetMs){
      try { localStorage.setItem(LS_ML_SLOW, "1"); } catch(e){}
      log("ml-budget-exceeded", { ms: ms(t0) });
      throw new Error("ml budget exceeded");
    }
    const res = await session.run({ input: new ort.Tensor("float32", data, dims) });
    return res.output.data;
  };
  const { outL, outR } = await separateInstrumental(chL, chR, runFn);
  if (scale !== 1){
    for (let i=0;i<outL.length;i++){ outL[i]/=scale; outR[i]/=scale; }
  }
  const out = ctx.createBuffer(2, buf.length, MODEL_RATE); // createBuffer accepts any rate
  out.copyToChannel(outL, 0);
  out.copyToChannel(outR, 1);
  return await resample(out, playRate);
}
