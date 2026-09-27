/* Shared E2E plumbing: serve dist/ like GitHub Pages does, and launch the
   two browsers the game has to work in (phone WebKit, desktop Chromium). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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

export const PROFILES = {
  phone: { type: webkit, context: { ...devices["iPhone 13"] } },
  desktop: { type: chromium, launch: { args: ["--autoplay-policy=no-user-gesture-required"] }, context: { viewport: { width: 1440, height: 900 } } },
};

export async function open(profile, { reducedMotion = false } = {}){
  const p = PROFILES[profile];
  const browser = await p.type.launch(p.launch || {});
  const context = await browser.newContext({ ...p.context, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
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
