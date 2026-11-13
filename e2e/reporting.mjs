/* Error reporting (docs/testing-and-deploy.md, Error reporting). The build
   CI tests has no DSN: it must hold no SDK and never call Sentry, whatever
   goes wrong. A second build with a made-up DSN must report an uncaught
   error, an unhandled rejection, a render crash and dead streams (capped per
   page load), and every request must hold the allowlisted fields only: no
   group invite, room code, URL, name, title or saved data, although the
   forced errors carry all of them.
   Usage: node e2e/reporting.mjs [--profile=phone|desktop] */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { serve, open, args, WORKER_HOST } from "./harness.mjs";

const A = args({ profile: "phone" });
const ROOT = path.resolve(import.meta.dirname, "..");
// .invalid never resolves, so nothing reaches Sentry even if a route is missed.
const SENTRY_HOST = "sentry-e2e.invalid";
const DSN = `https://0123456789abcdef0123456789abcdef@${SENTRY_HOST}/1`;
const SHA = "e2e".padEnd(40, "0");
const DEAD_HOST = "dead-stream.invalid";
const INVITE = "abcdefgh2345.AbCdEfGhIjKlMnOpQrStUv";
const ROOM = "ABCD";
const NAMES = ["Zubeida", "Farrokh"];

const track = n => ({ title: `Hidden Title ${n}`, artist: "Quiet Singer", stream: `https://${DEAD_HOST}/private/clip-${n}.mp4`, duration: 240, year: 2012 });
const SAVE = {
  v: 7,
  settings: { play: "pass", mix: "both", difficulty: "easy", mode: "players", rounds: 3 },
  players: NAMES.map((name, i) => ({ id: `p${i + 1}`, name, members: [] })),
  game: { queue: [1, 2, 3, 4, 5, 6].map(track), trackIdx: 1, turn: 1, round: 1, totalRounds: 3, difficulty: "easy",
    cast: NAMES.map((name, i) => ({ id: `p${i + 1}`, name, members: [], score: i ? 0 : 100 })),
    history: [{ id: "p1", song: "Hidden Title 1", points: 100, round: 1 }] },
};
// One message with everything an event must never hold, and what must be left of it.
const LEAKY = `boom at https://${DEAD_HOST}/private/clip-9.mp4 and https://${WORKER_HOST}/api/songs?ids=1 with #join=${INVITE} in room ${ROOM}, invite ${INVITE}, '${NAMES[0]}' "Hidden Title 1"`;
const SCRUBBED = "boom at [url] and [url] with [param] in room [code], invite [token], [cut]";
const SECRETS = [INVITE, ...INVITE.split("."), ROOM, "join=", "room=", DEAD_HOST, "clip-", WORKER_HOST, "saavn", "localhost", "Hidden Title", "Quiet Singer", ...NAMES, "tuneteasers_v7"];

const results = [];
async function check(name, fn){
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e){ results.push(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
const expect = (ok, msg) => { if (!ok) throw new Error(msg); };
async function until(ok, what, ms = 15000){
  for (const t0 = Date.now(); !ok();){
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/* A browser on one build. `sent` holds every request to the DSN's host, and
   `sentryish` every request that looks like Sentry's at all (its chunk, an envelope). */
async function visit(dir){
  const server = await serve(dir);
  const { browser, context, page } = await open(A.profile);
  const sent = [], sentryish = [];
  context.on("request", r => { if (/sentry|\/envelope\//i.test(r.url())) sentryish.push(r.url()); });
  await context.route(u => u.host === SENTRY_HOST, route => {
    const r = route.request();
    sent.push({ url: r.url(), referer: r.headers().referer || "", body: r.postData() || "" });
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: "{}" });
  });
  // The made-up invite must not reach the deployed Worker.
  await context.route(u => u.host === WORKER_HOST || u.host === DEAD_HOST, r => r.abort("connectionrefused"));
  return { url: server.url, page, sent, sentryish, close: async () => { await browser.close(); server.close(); } };
}
const events = sent => sent.map(s => JSON.parse(s.body.split("\n")[2]));
const inline = (page, code) => page.addScriptTag({ content: code });

/* An invite link, then a room link, with an uncaught error, an unhandled
   rejection and a render crash on the way. `reported` waits for each event. */
async function crashes(v, reported){
  const { page, url } = v;
  await page.goto(url + "seed.html");
  await page.evaluate(save => { localStorage.clear(); localStorage.setItem("tuneteasers_v7", JSON.stringify(save)); }, SAVE);
  await page.goto(url + "#join=" + INVITE);
  await page.getByRole("form", { name: "Join a group" }).waitFor();
  // The SDK takes over window.onerror once it has loaded; a build without it gets a second to show that it never does.
  if (reported) await page.waitForFunction(() => typeof window.onerror === "function");
  else await page.waitForTimeout(1000);
  await inline(page, `setTimeout(() => { throw new Error(${JSON.stringify(LEAKY)}); })`);
  if (reported) await reported(1);

  await page.evaluate(code => { location.hash = "#room=" + code; }, ROOM);
  await page.getByLabel(`Room code ${ROOM}`).waitFor();
  await inline(page, `Promise.reject(new Error(${JSON.stringify(LEAKY)}))`);
  if (reported) await reported(2);

  // Every screen change scrolls to the top in an effect, so this crashes the next screen inside React.
  await page.evaluate(m => { window.scrollTo = () => { throw new Error(m); }; }, LEAKY);
  await page.getByRole("button", { name: "Back to the start", exact: true }).click();
  await page.getByRole("heading", { name: "Something went wrong" }).waitFor();
  if (reported) await reported(3);
}

/* The saved game's streams are all dead: resume it and skip on from each one. */
async function deadStreams(v, songs){
  const { page, url } = v;
  await page.goto(url + "seed.html");
  await page.goto(url);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: /^It's with me|roll it$/ }).click();
  for (let n = 1; n <= songs; n++){
    await page.getByText(/Skip it to try another/).waitFor({ timeout: 30000 });
    if (n === songs) break;
    await page.getByRole("button", { name: "Skip this song" }).click();
    await page.getByText("Another one").waitFor();
  }
}

await check("a build without a DSN holds no SDK", async () => {
  const files = fs.readdirSync(path.join(ROOT, "dist/assets"));
  expect(!files.some(f => /sentry/i.test(f)), "dist/assets has a Sentry chunk");
  expect(!files.some(f => f.endsWith(".js") && fs.readFileSync(path.join(ROOT, "dist/assets", f), "utf8").includes("sentry.javascript")), "a script in dist/assets holds the SDK");
});

await check("without a DSN nothing is ever sent to Sentry, whatever goes wrong", async () => {
  const v = await visit();
  try {
    await crashes(v, null);
    await deadStreams(v, 1);
    await v.page.waitForTimeout(1500);
    expect(!v.sent.length && !v.sentryish.length, `requests: ${[...v.sent.map(s => s.url), ...v.sentryish].join(", ")}`);
  } finally { await v.close(); }
});

const built = fs.mkdtempSync(path.join(os.tmpdir(), "tt-reporting-"));
execFileSync("npx", ["vite", "build", "--outDir", built, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, env: { ...process.env, SENTRY_DSN: DSN, GITHUB_SHA: SHA }, stdio: "inherit" });
const v = await visit(built);
try {
  let crashed = [], streams = [];
  await check("an uncaught error, an unhandled rejection and a render crash are each reported", async () => {
    await crashes(v, n => until(() => v.sent.length >= n, `report ${n}`));
    await v.page.waitForTimeout(500);
    crashed = events(v.sent);
    expect(crashed.length === 3, `${crashed.length} events, not 3`);
    const got = crashed.map(e => `${e.exception?.values?.[0]?.mechanism?.type} on ${e.tags?.screen}`);
    const want = ["auto.browser.global_handlers.onerror on group", "auto.browser.global_handlers.onunhandledrejection on join", "generic on setup"];
    expect(JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
  });

  await check("error messages are scrubbed, and stack frames name built assets only", async () => {
    const values = crashed.map(e => e.exception.values[0]);
    for (const x of values) expect(x.type === "Error" && x.value === SCRUBBED, `value ${JSON.stringify(x.value)}`);
    const files = values.flatMap(x => x.stacktrace?.frames ?? []).map(f => f.filename);
    expect(files.length > 0, "no stack frames at all");
    expect(files.every(f => f === "other" || /^assets\/[\w.-]+\.js$/.test(f)), `frame files ${JSON.stringify([...new Set(files)])}`);
    expect(files.some(f => f.startsWith("assets/")), "the render crash has no frame in a built asset");
  });

  await check("dead streams are reported, three for a page load at most", async () => {
    const before = v.sent.length;
    await deadStreams(v, 4);
    const failed = await v.page.evaluate(() => window.__ttLog.dump().filter(e => e.tag === "element-fail").length);
    expect(failed >= 4, `only ${failed} element-fail entries`);
    await until(() => v.sent.length >= before + 3, "three stream reports");
    await v.page.waitForTimeout(1500);
    streams = events(v.sent.slice(before));
    expect(streams.length === 3, `${streams.length} stream reports, not 3`);
    for (const e of streams){
      expect(e.level === "warning" && /^stream element-fail( [a-z0-9 ]+)?$/.test(e.message), `message ${JSON.stringify(e.message)}`);
      expect(e.tags.screen === "playing" && e.extra.log.some(l => / element-fail err=/.test(l)), `screen ${e.tags.screen}, log ${JSON.stringify(e.extra.log.slice(-3))}`);
    }
  });

  await check("every request holds the allowlisted fields only", async () => {
    expect(v.sent.length === 6, `${v.sent.length} requests, not 6`);
    const keys = (o, allowed, what) => { const extra = Object.keys(o).filter(k => !allowed.includes(k)); expect(!extra.length, `${what} also has ${extra}`); };
    for (const s of v.sent){
      const lines = s.body.split("\n");
      expect(lines.length === 3 && lines[1] === '{"type":"event"}', `envelope items ${lines.slice(1, -1)}`);
      const head = JSON.parse(lines[0]), e = JSON.parse(lines[2]);
      keys(head, ["event_id", "sent_at", "sdk"], "envelope header");
      keys(head.sdk, ["name", "version"], "envelope sdk");
      keys(e, ["event_id", "timestamp", "platform", "level", "release", "message", "exception", "tags", "extra", "request", "sdk"], "event");
      keys(e.tags, ["screen"], "tags");
      keys(e.extra, ["log"], "extra");
      keys(e.request, ["headers"], "request");
      keys(e.request.headers, ["User-Agent"], "request headers");
      keys(e.sdk, ["name", "version", "integrations", "packages", "settings"], "sdk");
      for (const x of e.exception?.values ?? []){
        keys(x, ["type", "value", "stacktrace", "mechanism"], "exception");
        for (const f of x.stacktrace?.frames ?? []) keys(f, ["filename", "function", "lineno", "colno", "in_app"], "frame");
      }
      expect(e.release === SHA, `release ${e.release}`);
      expect(e.sdk.settings?.infer_ip === "never", `infer_ip ${e.sdk.settings?.infer_ip}`);
      expect(e.extra.log.every(l => /^[\d:.]* ?[a-z-]+( [a-zA-Z]+=[a-z0-9 ._-]+)*$/.test(l)), `log ${JSON.stringify(e.extra.log)}`);
      const sentTo = new URL(s.url);
      expect(sentTo.pathname === "/api/1/envelope/" && [...sentTo.searchParams.keys()].join() === "sentry_version,sentry_key,sentry_client", `sent to ${s.url}`);
      expect(!s.referer || s.referer === new URL(v.url).origin + "/", `referer ${s.referer}`);
    }
  });

  await check("no request carries the invite, the room code, a URL, a name, a title or saved data", async () => {
    for (const s of v.sent){
      const text = s.url.replace(`https://${SENTRY_HOST}`, "") + "\n" + s.body;
      const found = SECRETS.filter(x => text.includes(x));
      expect(!found.length, `found ${found.join(", ")}`);
      expect(!/[a-z][a-z0-9+.-]*:\/\//i.test(text), `a URL: ${/\S*:\/\/\S*/.exec(text)?.[0]}`);
    }
  });
} finally {
  await v.close();
  fs.rmSync(built, { recursive: true, force: true });
}

console.log(`reporting e2e (${A.profile})\n` + results.join("\n"));
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
