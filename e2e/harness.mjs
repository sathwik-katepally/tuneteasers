/* Shared E2E plumbing: serve dist/ like GitHub Pages does, and launch the
   two browsers the game has to work in (phone WebKit, desktop Chromium). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { chromium, webkit, devices } from "playwright";

const DIST = path.resolve(import.meta.dirname, "../dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

export function serve(){
  return new Promise(resolve => {
    const srv = http.createServer((q, s) => {
      let f = path.join(DIST, decodeURIComponent(q.url.split("?")[0]));
      if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => {
        if (e){ s.writeHead(404); return s.end(); }
        s.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
        s.end(d);
      });
    }).listen(0, () => resolve({ url: `http://localhost:${srv.address().port}/`, close: () => srv.close() }));
  });
}

const WORKER_DIR = path.resolve(import.meta.dirname, "../worker");
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

/* The Worker under `wrangler dev` with a fresh local D1 (migrations applied). */
export async function localWorker(){
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "tt-group-e2e-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { cwd: WORKER_DIR, stdio: "ignore" });
  const [port, inspector] = [await freePort(), await freePort()];
  const proc = spawn("npx", ["wrangler", "dev", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persist], { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wrangler dev did not start:\n" + out.slice(-800))), 60000);
    const read = d => { out += d; if (/Ready on/.test(out)){ clearTimeout(timer); resolve(); } };
    proc.stdout.on("data", read); proc.stderr.on("data", read);
    proc.on("exit", code => reject(new Error(`wrangler dev exited ${code}:\n${out.slice(-800)}`)));
  });
  const sql = command => execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", persist, "--command", command], { cwd: WORKER_DIR, stdio: "ignore" });
  return { origin: `http://localhost:${port}`, sql, stop: () => { proc.kill(); fs.rmSync(persist, { recursive: true, force: true }); } };
}

/* Test browsers must not play out loud on the machine running them.
   Chromium has --mute-audio; WebKit has no switch, so this init script sends
   everything to a zero gain and keeps element volume at 0 while the page
   still reads back its own volume, muted flag, timing and play state. */
export function silenceAudio(){
  const vol = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  const wanted = new WeakMap();
  Object.defineProperty(HTMLMediaElement.prototype, "volume", {
    configurable: true,
    get(){ return wanted.has(this) ? wanted.get(this) : vol.get.call(this); },
    set(v){ vol.set.call(this, v); wanted.set(this, vol.get.call(this)); vol.set.call(this, 0); },
  });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(){
    if (!wanted.has(this)) wanted.set(this, vol.get.call(this));
    vol.set.call(this, 0);
    return play.call(this);
  };
  const hush = new WeakMap();
  const gateOf = dest => {
    let g = hush.get(dest.context);
    if (!g){ g = dest.context.createGain(); g.gain.value = 0; connect.call(g, dest); hush.set(dest.context, g); }
    return g;
  };
  const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function(dest, ...rest){
    if (dest instanceof AudioDestinationNode){ connect.call(this, gateOf(dest), ...rest); return dest; }
    return connect.call(this, dest, ...rest);
  };
  AudioNode.prototype.disconnect = function(dest, ...rest){
    return disconnect.call(this, dest instanceof AudioDestinationNode ? gateOf(dest) : dest, ...rest);
  };
}

export const PROFILES = {
  phone: { type: webkit, context: { ...devices["iPhone 13"] } },
  desktop: { type: chromium, launch: { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] }, context: { viewport: { width: 1440, height: 900 } } },
};

export async function open(profile, { reducedMotion = false } = {}){
  const p = PROFILES[profile];
  const browser = await p.type.launch(p.launch || {});
  const context = await browser.newContext({ ...p.context, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  if (p.type === webkit) await context.addInitScript(silenceAudio);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e.message)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  return { browser, context, page, errors };
}

export function args(defaults){
  const out = { ...defaults };
  for (const a of process.argv.slice(2)){
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    out[k] = v;
  }
  return out;
}

export const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("tuneteasers_v7") || "null"));
