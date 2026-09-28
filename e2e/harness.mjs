/* Shared E2E plumbing: serve dist/ like GitHub Pages does, and launch the
   two browsers the game has to work in (phone WebKit, desktop Chromium). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { chromium, webkit, devices } from "playwright";
import lockfile from "proper-lockfile";

/* One heavy browser suite at a time per machine: parallel agent worktrees
   running suites together overload the laptop until timing checks flake.
   Every suite imports this module, so the lock is taken before anything
   launches. It lives in /tmp, not os.tmpdir(): agent sessions get their own
   TMPDIR, and the lock must be shared by every worktree and session. A killed
   suite stops refreshing it and it goes stale after STALE_MS (long enough
   that a blocking execFileSync, like the D1 migrations, cannot fake a death).
   CI runners have one suite per machine and skip it. */
const LOCK = path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "tuneteasers-e2e");
const LOCK_OWNER = LOCK + ".owner";
const STALE_MS = 60000;
async function suiteLock(){
  const me = `pid ${process.pid} in ${process.cwd()}: node ${path.relative(process.cwd(), process.argv[1] || "")} ${process.argv.slice(2).join(" ")}`.trim();
  let waitingSince = 0;
  for (;;){
    try {
      await lockfile.lock(LOCK, { realpath: false, stale: STALE_MS, onCompromised: e => console.warn(`E2E suite lock lost (${e.message}); another suite may start alongside this one.`) });
      fs.writeFileSync(LOCK_OWNER, JSON.stringify({ owner: me, since: Date.now() }));
      if (waitingSince) console.log(`E2E suite lock acquired after ${Math.round((Date.now() - waitingSince) / 1000)}s.`);
      return;
    } catch (e){
      if (e.code !== "ELOCKED") throw e;
      if (!waitingSince){
        waitingSince = Date.now();
        let holder = "another suite";
        try { const o = JSON.parse(fs.readFileSync(LOCK_OWNER, "utf8")); holder = `${o.owner}, running ${Math.round((Date.now() - o.since) / 1000)}s`; } catch {}
        console.log(`Waiting for another E2E suite to finish (${holder}). Lock: ${LOCK}.lock`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
if (!process.env.CI) await suiteLock();

const DIST = path.resolve(import.meta.dirname, "../dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png" };

export function serve(){
  return new Promise(resolve => {
    const srv = http.createServer((q, s) => {
      let f = path.join(DIST, decodeURIComponent(q.url.split("?")[0]));
      if (f.endsWith("/")) f += "index.html";
      fs.readFile(f, (e, d) => {
        if (e){ s.writeHead(404, { "content-type": "text/plain" }); return s.end("Not found"); }
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

/* Test browsers must never make a sound on the machine running them.
   Chromium has a flag for it; WebKit gets this init script, which silences
   the output without touching what the tests read (media time, paused,
   muted, the engine's gain gate): element volume goes to 0, and each
   AudioContext's destination is swapped for a zero-gain node in front of it.
   OfflineAudioContext keeps its real destination, so offline rendering is
   unaffected. */
export const MUTE_ARGS = ["--mute-audio"];
export function silence(){
  const P = HTMLMediaElement.prototype, play = P.play;
  P.play = function(...a){ this.volume = 0; return play.apply(this, a); };
  const Live = window.AudioContext || window.webkitAudioContext;
  const proto = (window.BaseAudioContext || Live)?.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "destination");
  if (!desc?.get) return;
  Object.defineProperty(proto, "destination", { configurable: true, get(){
    const real = desc.get.call(this);
    if (!(this instanceof Live)) return real;
    if (!this.__ttSilent){ const g = this.createGain(); g.gain.value = 0; g.connect(real); this.__ttSilent = g; }
    return this.__ttSilent;
  } });
}

/* The landing page shows only on a first visit. Scripts that are not about
   it start every page as a returning visitor, even after clearing storage. */
export function skipLanding(){
  try { localStorage.setItem("tt_landing_seen", "1"); } catch {}
}

export const PROFILES = {
  phone: { type: webkit, context: { ...devices["iPhone 13"] } },
  desktop: { type: chromium, launch: { args: ["--autoplay-policy=no-user-gesture-required", ...MUTE_ARGS] }, context: { viewport: { width: 1440, height: 900 } } },
};

export async function open(profile, { reducedMotion = false, landing = false } = {}){
  const p = PROFILES[profile];
  const browser = await p.type.launch(p.launch || {});
  const context = await browser.newContext({ ...p.context, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await context.addInitScript(silence);
  if (!landing) await context.addInitScript(skipLanding);
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

/* The deployed Worker's host, rerouted in a browser context to `workerOrigin`
   (a local `wrangler dev` or a preview): HTTP through Playwright, WebSockets
   through a proxy in the test script that appends every frame to `log` as
   { at, dir: "in" | "out", data }. onIn gets each parsed frame the page
   receives, onOut each raw frame it sends. */
export const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";
export async function wireWorker(context, workerOrigin, pageOrigin, log, { onIn, onOut } = {}){
  await context.route(u => u.host === WORKER_HOST, async route => {
    const u = new URL(route.request().url());
    try {
      const res = await route.fetch({ url: workerOrigin + u.pathname + u.search });
      return route.fulfill({ response: res });
    } catch { return route.abort(); }
  });
  await context.routeWebSocket(u => u.host === WORKER_HOST, ws => {
    const u = new URL(ws.url());
    const up = new WebSocket(workerOrigin.replace(/^http/, "ws") + u.pathname + u.search, { headers: { origin: pageOrigin } });
    const pending = [];
    up.onopen = () => { for (const m of pending.splice(0)) up.send(m); };
    up.onmessage = e => {
      const data = String(e.data);
      log.push({ at: Date.now(), dir: "in", data });
      if (onIn) try { onIn(JSON.parse(data)); } catch {}
      ws.send(data);
    };
    up.onclose = e => { try { ws.close({ code: e.code >= 4000 ? e.code : 1000, reason: e.reason }); } catch {} };
    ws.onMessage(m => {
      const data = String(m);
      log.push({ at: Date.now(), dir: "out", data });
      onOut?.(data);
      if (up.readyState === 1) up.send(data); else pending.push(data);
    });
    ws.onClose(() => { try { up.close(); } catch {} });
  });
}

export const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem("tuneteasers_v7") || "null"));

/* Setup keeps era, difficulty, song kinds and rounds behind its summary line; open it. */
export async function moreSettings(page){
  const summary = page.getByRole("button", { name: /Change$/ });
  if (await summary.count()) await summary.click();
  await page.getByRole("radiogroup", { name: "Difficulty" }).waitFor();
}
