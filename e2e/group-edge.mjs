/* Group sync edge cases that the two-phone journey cannot time on purpose.
   Drives the real client module (src/lib/group.ts through the Vite dev
   server) in Chromium against a local `wrangler dev` with a fresh D1:
   - switching groups while the old group's upload is in flight must not
     touch the new group's queued plays, and those plays still get sent;
   - one failed cooldown read must not stop the next crate from reading again;
   - an invite to a group idle past its expiry is refused, and a write
     cannot bring the group back;
   - a malformed #join= link shows a clear message instead of throwing.
   node e2e/group-edge.mjs */
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { localWorker } from "./harness.mjs";

const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";
const worker = await localWorker();
const vite = await createServer({ root: path.resolve(import.meta.dirname, ".."), server: { port: 0 }, logLevel: "silent" });
await vite.listen();
const base = vite.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e.message)));

const net = { down: false, reads: 0, holdRounds: false, release: null, held: null };
await page.route(u => u.host === WORKER_HOST, async route => {
  const u = new URL(route.request().url());
  if (u.pathname === "/api/group/played") net.reads++;
  if (net.down) return route.abort("connectionrefused");
  const res = await route.fetch({ url: worker.origin + u.pathname + u.search });
  if (net.holdRounds && u.pathname === "/api/group/rounds"){
    net.holdRounds = false;
    net.held();
    await new Promise(r => { net.release = r; });
  }
  return route.fulfill({ response: res });
});

const api = async (invite, p, init = {}) => {
  const r = await fetch(worker.origin + "/api" + p, { ...init, headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const results = [];
async function check(name, fn){
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e){ results.push(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
const expect = (ok, msg) => { if (!ok) throw new Error(msg); };

try {
  await page.goto(base);
  await page.evaluate(async () => {
    localStorage.clear();
    window.g = await import("/src/lib/group.ts");
  });

  await check("a failed cooldown read does not block the next one", async () => {
    await page.evaluate(() => g.createGroup("Edge recovery", false));
    net.down = true;
    const failed = await page.evaluate(() => g.groupPlayed());
    expect(failed === null, "read with the Worker down should give null");
    net.down = false;
    net.reads = 0;
    const again = await page.evaluate(() => g.groupPlayed());
    expect(net.reads === 1, `expected 1 cooldown request after recovery, saw ${net.reads}`);
    expect(again && typeof again === "object", "recovered read returned null");
  });

  await check("an old group's in-flight upload leaves the new group's queue alone", async () => {
    const a = await page.evaluate(async () => { await g.createGroup("Edge A", false); return g.currentGroup(); });
    let held;
    const arrived = new Promise(r => { held = r; });
    net.held = held;
    net.holdRounds = true;
    await page.evaluate(() => g.recordPlay("edge old group song"));
    await arrived;
    const b = await page.evaluate(async () => { await g.createGroup("Edge B", false); g.recordPlay("edge new group song"); return g.currentGroup(); });
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("tt_group_outbox")));
    expect(before.groupId === b.id && before.rounds.length === 1, "B's play was not queued");
    net.release();
    await page.waitForFunction(() => {
      const o = JSON.parse(localStorage.getItem("tt_group_outbox") || "null");
      return o && o.rounds.length === 0;
    }, null, { timeout: 15000 }).catch(() => {});
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("tt_group_outbox")));
    expect(after.groupId === b.id, `outbox now belongs to ${after.groupId}, not the current group ${b.id}`);
    const bPlayed = (await api(b.invite, "/group/played")).body.played;
    expect(bPlayed["edge new group song"], "B's play never reached B");
    const aPlayed = (await api(a.invite, "/group/played")).body.played;
    expect(aPlayed["edge old group song"] && !aPlayed["edge new group song"], "plays landed in the wrong group");
  });

  await check("an idle-expired group refuses its invite and stays expired", async () => {
    const made = await (await fetch(worker.origin + "/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Edge expired" }) })).json();
    const old = Date.now() - 366 * 86400e3;
    worker.sql(`UPDATE groups SET active_at = ${old} WHERE id = '${made.group.id}'`);
    const read = await api(made.invite, "/group");
    expect(read.status === 403, `expired group read answered ${read.status}`);
    const write = await api(made.invite, "/group/rounds", { method: "POST", body: JSON.stringify({ rounds: [{ id: "edgeexpired1", key: "edge song" }] }) });
    expect(write.status === 403, `expired group write answered ${write.status}`);
    const again = await api(made.invite, "/group");
    expect(again.status === 403, "the write brought the expired group back");
  });

  await check("a malformed #join= link is handled", async () => {
    errors.length = 0;
    await page.goto(base + "#join=%");
    await page.getByText("That invite link is incomplete").waitFor({ timeout: 10000 });
    expect((await page.evaluate(() => location.hash)) === "", "broken invite left in the address bar");
    expect(!errors.length, "page errors: " + errors.join(" | "));
  });
} finally {
  await browser.close();
  await vite.close();
  worker.stop();
}
console.log(results.join("\n"));
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
