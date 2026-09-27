/* Corpus tier E2E: a real game loads and plays from corpus.json in both
   languages, resolving ids through (a) the local wrangler dev worker,
   (b) the deployed worker, and (c) no batch endpoint at all, which must fall
   back to raw Saavn search. Run: node scripts/corpus-e2e.cjs [repo-dir] [local-worker-origin] */
const { chromium, webkit } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const REPO = process.argv[2] || path.join(__dirname, "..");
const LOCAL = process.argv[3] || "http://127.0.0.1:8787";
const DIST = path.join(REPO, "dist");
const WORKER_HOST = "tuneteasers-saavn.sathwik-katepally.workers.dev";
const DEPLOYED_WORKER = `https://${WORKER_HOST}`;
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png" };
const corpusFile = JSON.parse(fs.readFileSync(path.join(DIST, "corpus.json"), "utf8"));
const corpus = corpusFile.songs.map(r => Object.fromEntries(corpusFile.cols.map((c, i) => [c, r[i]])));
const byTitle = new Map(corpus.map(s => [`${s.language}|${s.title}`, s]));

const srv = http.createServer((q, s) => {
  let f = path.join(DIST, decodeURIComponent(q.url.split("?")[0]));
  if (f.endsWith("/")) f += "index.html";
  fs.readFile(f, (e, d) => { if (e) { s.writeHead(404); return s.end(); } s.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); s.end(d); });
});

const SCENARIOS = [
  { name: "local-worker bolly", mix: "Hindi", lang: "hindi", localWorker: true, blockMirror: true, expect: "corpus", via: "127.0.0.1" },
  { name: "local-worker telugu", mix: "Telugu", lang: "telugu", localWorker: true, blockMirror: true, expect: "corpus", via: "127.0.0.1" },
  { name: "deployed-worker bolly", mix: "Hindi", lang: "hindi", expect: "corpus", via: DEPLOYED_WORKER },
  { name: "deployed-worker telugu", mix: "Telugu", lang: "telugu", expect: "corpus", via: DEPLOYED_WORKER },
  { name: "no-batch-endpoint both", mix: "Both", blockMirror: true, blockLocalSongs: true, expect: "saavn" },
  { name: "webkit local-worker both", mix: "Both", localWorker: true, blockMirror: true, expect: "corpus", via: "127.0.0.1", browser: "webkit" },
];

async function run(sc, url){
  const bt = sc.browser === "webkit" ? webkit : chromium;
  const b = await bt.launch(sc.browser === "webkit" ? {} : { args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
  const p = await b.newPage(sc.browser === "webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true } : {});
  const reqs = [];
  await p.route("**/*", async r => {
    const u = new URL(r.request().url());
    if (u.host === WORKER_HOST && sc.localWorker){
      // stand in for the deployed worker with the local wrangler dev instance
      const local = LOCAL + u.pathname + u.search;
      reqs.push(local);
      try {
        const res = await fetch(local);
        return r.fulfill({ status: res.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: await res.text() });
      } catch (e){ return r.abort(); }
    }
    if (u.host === WORKER_HOST && sc.blockLocalSongs && u.pathname === "/api/songs")
      return r.fulfill({ status: 404, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: '{"success":false}' });
    if (/saavn|itunes/.test(u.host)) reqs.push(u.href);
    return r.continue();
  });
  const logs = [];
  p.on("console", m => { if (/crate|play |fallback|fail/.test(m.text())) logs.push(m.text().slice(0, 300)); });
  await p.goto(url);
  await p.getByRole("radio", { name: sc.mix, exact: true }).click();
  await p.getByRole("button", { name: /Start the show/ }).click();
  const handover = p.getByRole("button", { name: /^It's with me/ });
  await handover.waitFor({ timeout: 45000 });
  await p.waitForFunction(() => JSON.parse(localStorage.getItem("tuneteasers_v7") || "{}").game);
  const state = await p.evaluate(() => JSON.parse(localStorage.getItem("tuneteasers_v7")));
  const queue = state.game.queue;
  await handover.click();
  await p.waitForFunction(() => window.__ttLastMode, null, { timeout: 25000 });
  const mode = await p.evaluate(() => window.__ttLastMode);
  await p.getByRole("button", { name: "I know this one" }).click();
  await p.getByRole("button", { name: "Show the answer" }).click();
  await p.getByRole("button", { name: /Got it/ }).waitFor();
  await p.waitForTimeout(1800);
  const reveal = await p.evaluate(() => document.body.innerText);
  await b.close();

  const crate = logs.find(l => l.includes("crate")) || "";
  const problems = [];
  if (!["snip", "muffle", "plain"].includes(mode)) problems.push(`mode=${mode}`);
  if (!/Got it/i.test(reveal)) problems.push("no reveal");
  if (state.game.source !== sc.expect) problems.push(`source=${state.game.source} expected ${sc.expect}`);
  if (sc.expect === "corpus"){
    const langOk = sc.lang ? queue.every(t => t.lang === (sc.lang === "hindi" ? "bolly" : "telugu")) : true;
    if (!langOk) problems.push("language mismatch in queue");
    let mism = 0;
    for (const t of queue){
      const c = byTitle.get(`${t.lang === "bolly" ? "hindi" : "telugu"}|${t.title}`);
      if (!c || c.year !== t.year || c.film !== t.album || !["easy", "medium", "hard"].includes(t.tier)) mism++;
    }
    if (mism) problems.push(`${mism}/${queue.length} queue tracks do not match corpus film/year/tier`);
    if (!/,\s*(19|20)\d\d/.test(reveal)) problems.push("reveal lacks film/year");
    const songReqs = reqs.filter(u => u.includes("/api/songs?ids="));
    if (!songReqs.length) problems.push("no batch id request");
    if (sc.via && !songReqs.every(u => u.includes(sc.via))) problems.push("batch requests not via " + sc.via);
  }
  const ok = !problems.length;
  console.log(ok ? "PASS" : "FAIL", sc.name, `| queue=${queue.length} mode=${mode} source=${state.game.source}`, problems.join("; "), "|", crate.slice(0, 160));
  return ok;
}

srv.listen(0, async () => {
  const url = `http://localhost:${srv.address().port}/`;
  let fail = 0;
  for (const sc of SCENARIOS){
    try { if (!(await run(sc, url))) fail++; }
    catch (e){ fail++; console.log("FAIL", sc.name, "|", String(e.message || e).slice(0, 200)); }
  }
  srv.close(); process.exit(fail ? 1 : 0);
});
