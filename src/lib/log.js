/* Structured diagnostics for the audio pipeline.
   Ring buffer mirrored to the console and persisted to localStorage, so
   evidence survives a tab reload — an iOS jetsam kill is otherwise invisible
   (a "boot" entry with no preceding "pagehide" is the reload signature).
   Device-local only, like all game data. Read on-device via the ?debug=1
   overlay or window.__ttLog.dump() in a console. */
const KEY = "tt_log";
const MAX = 250;

let buf = [];
try { const raw = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(raw)) buf = raw; } catch(e){}
let seq = buf.length ? (buf[buf.length-1].n || 0) : 0;
const listeners = new Set();

function save(){ try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch(e){} }

export function log(tag, data = {}){
  const e = { n: ++seq, t: new Date().toISOString().slice(11, 23), tag, ...data };
  buf.push(e);
  if (buf.length > MAX) buf = buf.slice(-MAX);
  save();
  try { console.info("[tt]", tag, data); } catch(e2){}
  for (const fn of listeners){ try { fn(e); } catch(e2){} }
}

export const ms = t0 => Math.round(performance.now() - t0);
export const errMsg = e => String((e && e.message) || e).slice(0, 160);

export function logDump(){ return buf.slice(); }
export function logClear(){ buf = []; seq = 0; save(); }
export function onLog(fn){ listeners.add(fn); return () => listeners.delete(fn); }

if (typeof window !== "undefined"){
  window.__ttLog = { dump: logDump, clear: logClear };
  window.addEventListener("error", ev => log("js-error", { msg: String(ev.message).slice(0, 160) }));
  window.addEventListener("unhandledrejection", ev => log("js-rejection", { msg: errMsg(ev.reason) }));
  // A clean exit logs pagehide; a jetsam kill does not. persisted=true marks bfcache restores.
  window.addEventListener("pagehide", ev => log("pagehide", { persisted: !!ev.persisted }));
}
