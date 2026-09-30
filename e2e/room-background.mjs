/* A host that leaves the browser to send the room code.

   iOS suspends a backgrounded page and can drop its socket without a close
   event, so the socket still looks open and nothing arrives. Here the host's
   first socket goes silent in both directions (never closed) while the page is
   hidden, a phone joins, and the page comes back: the host must reconnect and
   show the player within a few seconds.

   node e2e/room-background.mjs */
import { webkit, devices } from "playwright";
import { serve, localWorker, silence, skipLanding, wireWorker, WORKER_HOST } from "./harness.mjs";

const fail = msg => { throw new Error(msg); };
const worker = await localWorker();
const server = await serve();
const origin = new URL(server.url).origin;
const browser = await webkit.launch();
try {
  const host = await browser.newContext({ ...devices["iPhone 13"], reducedMotion: "reduce" });
  await host.addInitScript(silence);
  await host.addInitScript(skipLanding);
  await host.route(u => u.host === WORKER_HOST, async route => {
    const u = new URL(route.request().url());
    try { return route.fulfill({ response: await route.fetch({ url: worker.origin + u.pathname + u.search }) }); } catch { return route.abort(); }
  });
  let silent = false, sockets = 0;
  await host.routeWebSocket(u => u.host === WORKER_HOST, ws => {
    const n = ++sockets;
    const u = new URL(ws.url());
    const up = new WebSocket(worker.origin.replace(/^http/, "ws") + u.pathname + u.search, { headers: { origin } });
    const pending = [];
    const dead = () => silent && n === 1;
    up.onopen = () => { for (const m of pending.splice(0)) up.send(m); };
    up.onmessage = e => { if (!dead()) ws.send(String(e.data)); };
    up.onclose = e => { if (!dead()) try { ws.close({ code: e.code >= 4000 ? e.code : 1000, reason: e.reason }); } catch {} };
    ws.onMessage(m => { if (dead()) return; if (up.readyState === 1) up.send(String(m)); else pending.push(String(m)); });
    ws.onClose(() => { try { up.close(); } catch {} });
  });
  const hostPage = await host.newPage();
  await hostPage.goto(server.url);
  await hostPage.getByRole("radio", { name: "Buzz in" }).click();
  await hostPage.getByRole("button", { name: "Open a room" }).click();
  await hostPage.getByText("Doors open").waitFor({ timeout: 20000 });
  const code = (await hostPage.locator("[aria-label^='Room code ']").first().getAttribute("aria-label")).replace(/Room code |\s/g, "");

  const setVisible = v => hostPage.evaluate(v => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, v);
  await setVisible(false);
  silent = true;

  const phone = await browser.newContext({ ...devices["iPhone 13"], reducedMotion: "reduce" });
  await phone.addInitScript(silence);
  await phone.addInitScript(skipLanding);
  await wireWorker(phone, worker.origin, origin, []);
  const phonePage = await phone.newPage();
  await phonePage.goto(server.url + "#room=" + code);
  await phonePage.getByLabel("Your name").fill("Asha");
  await phonePage.getByRole("button", { name: "Join the show" }).click();
  await phonePage.getByText("You're in").waitFor({ timeout: 15000 });
  await hostPage.waitForTimeout(2500);
  if (await hostPage.getByText("Asha", { exact: true }).count()) fail("the silent socket delivered the join; the test is not simulating a dead socket");

  await setVisible(true);
  await hostPage.getByText("Asha", { exact: true }).waitFor({ timeout: 5000 }).catch(() => fail("host did not show the player who joined while it was away"));
  if (sockets < 2) fail("host showed the player without reconnecting");
  console.log(`room-background: PASS (room ${code}, host reconnected on return)`);
} catch (e){
  console.error("room-background: FAIL", e.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  worker.stop();
}
// The suite lock and wrangler's children keep the event loop alive, as in the other room suites.
process.exit();
