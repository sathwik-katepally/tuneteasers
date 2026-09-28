/* Screenshot every ?proto= screen at phone (WebKit) and desktop (Chromium).
   node audit/protoshots.mjs --site=http://localhost:42030/ --out=<dir> */
import fs from "node:fs";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";
import { args, silence, MUTE_ARGS } from "../e2e/harness.mjs";

const A = args({ site: "http://localhost:42030/", out: "audit/shots" });
fs.mkdirSync(A.out, { recursive: true });
const NAMES = ["index", "landing", "setup", "setup-room", "lobby", "after", "history"];
for (const profile of ["phone", "desktop"]){
  const phone = profile === "phone";
  const browser = phone ? await webkit.launch() : await chromium.launch({ args: MUTE_ARGS });
  const context = await browser.newContext(phone ? { ...devices["iPhone 13"] } : { viewport: { width: 1440, height: 900 } });
  await context.addInitScript(silence);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  for (const n of NAMES){
    await page.goto(`${A.site}?proto=${n}`);
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const ctl = [...document.querySelectorAll("button, input, a[href]")].filter(e => vis(e) && !e.disabled);
      const groups = new Set(ctl.map(e => e.closest("[role=radiogroup]") || e));
      const start = [...document.querySelectorAll("button")].find(b => /Start the show|Open a room/.test(b.textContent));
      return { words: (document.body.innerText.match(/[\p{L}\p{N}'’]+/gu) || []).length, choices: groups.size,
        startTop: start ? Math.round(start.getBoundingClientRect().bottom) : null, vh: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth };
    });
    console.log(profile, n.padEnd(11), JSON.stringify(m));
    await page.screenshot({ path: path.join(A.out, `proto-${n}-${profile}.png`), fullPage: true });
    if (n === "setup"){
      await page.getByRole("button", { name: /Change/ }).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(A.out, `proto-setup-open-${profile}.png`), fullPage: false });
    }
  }
  if (errors.length) console.log("page errors:", errors);
  await browser.close();
}
