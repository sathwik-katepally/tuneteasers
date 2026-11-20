/* The game night hub records the games played on it into a group, and reads
   every finished game back for its standings. The hub's pages live in another
   repo, so this sends what a browser on each hub site sends (requests with its
   Origin, and the preflights before them) to a local `wrangler dev` with a
   fresh D1:
   - each hub site may record a game and read all finished games, and the
     preflight offers exactly that;
   - one game is one row: saved again it replaces the row, an older copy or a
     copy under another game does not;
   - the hub cannot record a TuneTeasers show, a game that is not on its list,
     or a malformed one;
   - shows and hub games read back together, newest first and in pages, while
     the app's own list of shows never contains a hub game;
   - a game past the results window is not served, and deleting the group
     deletes its games.
   node e2e/group-games.mjs */
import { localWorker } from "./harness.mjs";

const SITE = "https://sathwik-katepally.github.io";
const HUB_ORIGINS = ["https://gamenight.sathwik-katepally.workers.dev", "https://oddone.sathwik-katepally.workers.dev"];
const worker = await localWorker();

const results = [];
async function check(name, fn){
  try { await fn(); results.push(`PASS ${name}`); }
  catch (e){ results.push(`FAIL ${name}: ${e.message.split("\n")[0]}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`); }
}
const expect = (ok, msg) => { if (!ok) throw new Error(msg); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const made = await (await fetch(worker.origin + "/api/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hub games" }) })).json();
const from = (origin, p, init = {}) => fetch(worker.origin + "/api" + p, { ...init, headers: { origin, authorization: `Bearer ${made.invite}`, "content-type": "application/json", ...init.headers } });
const save = (origin, game) => from(origin, "/group/games", { method: "POST", body: JSON.stringify(game) });
const read = async (origin, p = "/group/games?limit=50") => (await from(origin, p)).json();
const [GAMENIGHT] = HUB_ORIGINS;
const now = Date.now();
const players = n => Array.from({ length: n }, (_, i) => ({ name: `Player ${i + 1}`, score: i }));

try {
  await check("each hub site may record a game and read every finished game", async () => {
    for (const [i, hub] of HUB_ORIGINS.entries()){
      for (const method of ["GET", "POST"]){
        const preflight = await from(hub, "/group/games", { method: "OPTIONS", headers: { "access-control-request-method": method } });
        expect(preflight.status === 204, `${hub} preflight for ${method} answered ${preflight.status}`);
        // A browser sends the request only if the preflight names its origin, the method and both headers.
        expect(preflight.headers.get("access-control-allow-origin") === hub, `${hub} preflight for ${method} did not name its origin`);
        expect(preflight.headers.get("access-control-allow-methods") === "GET, POST", `${hub} preflight offers ${preflight.headers.get("access-control-allow-methods")}`);
        const allowed = preflight.headers.get("access-control-allow-headers") || "";
        expect(/\bauthorization\b/i.test(allowed) && /\bcontent-type\b/i.test(allowed), `${hub} preflight allows only ${allowed}`);
      }
      // Forehead seats ten, more than a show's cast.
      const game = { id: `hub-site-${i}-game`, game: "forehead", mode: "players", finishedAt: now - 60000 + i, cast: players(10) };
      const saved = await save(hub, game);
      expect(saved.status === 200 && same(await saved.json(), { ok: true }), `${hub} save answered ${saved.status}`);
      expect(saved.headers.get("access-control-allow-origin") === hub, `${hub} save came back without its CORS header`);
      const back = (await read(hub)).games.find(g => g.id === game.id);
      expect(back, `${hub} does not read back the game it saved`);
      expect(same(back, { ...game, cast: game.cast.map(c => ({ ...c, members: [] })) }), `${hub} read back ${JSON.stringify(back)}`);
    }
    const stranger = await save("https://example.com", { id: "stranger-game-1", game: "forehead", mode: "players", cast: players(3) });
    expect(stranger.status === 403, `an unlisted site's save answered ${stranger.status}`);
    expect((await from("https://example.com", "/group/games")).status === 403, "an unlisted site could read the games");
  });

  await check("a game saved again replaces its row, an older copy or another game's copy does not", async () => {
    const game = { id: "charades-night-1", game: "charades", mode: "teams", finishedAt: now - 30000, cast: [{ name: "Red", score: 2 }, { name: "Blue", score: 1 }] };
    const later = { ...game, finishedAt: now - 20000, cast: [{ name: "Red", score: 2 }, { name: "Blue", score: 5 }] };
    for (const copy of [
      game,
      later,
      { ...game, finishedAt: now - 40000, cast: [{ name: "Red", score: 9 }, { name: "Blue", score: 9 }] },
      { ...later, game: "forehead", mode: "players", finishedAt: now - 10000, cast: players(3) },
    ]){
      const res = await save(GAMENIGHT, copy);
      expect(res.status === 200, `a save of ${copy.id} answered ${res.status}`);
    }
    const rows = (await read(GAMENIGHT)).games.filter(g => g.id === game.id);
    expect(rows.length === 1, `${rows.length} rows for one game`);
    expect(same(rows[0], { ...later, cast: later.cast.map(c => ({ ...c, members: [] })) }), `the row is ${JSON.stringify(rows[0])}`);
  });

  await check("the hub cannot record a show, a game that is not its own, or a malformed one", async () => {
    const good = { id: "refused-game-1", game: "forehead", mode: "players", cast: players(3) };
    const show = { id: "refused-show-1", finishedAt: now, mode: "players", difficulty: "easy", mix: "hindi", rounds: 3, songs: 3, cast: players(2) };
    const asShow = await from(GAMENIGHT, "/group/results", { method: "POST", body: JSON.stringify(show) });
    expect(asShow.status === 403, `a hub write of a show answered ${asShow.status}`);
    for (const [why, body] of [
      ["a TuneTeasers show as a game", { ...good, game: "tuneteasers" }],
      ["a game not on the list", { ...good, game: "chess" }],
      ["no game", { ...good, game: undefined }],
      ["a mode that is not one", { ...good, mode: "solo" }],
      ["an id that is not one", { ...good, id: "no" }],
      ["no cast", { ...good, cast: [] }],
      ["a cast of 17", { ...good, cast: players(17) }],
      ["a score that is not a number", { ...good, cast: [{ name: "A", score: "9" }] }],
      ["a name that is too long", { ...good, cast: [{ name: "x".repeat(25), score: 1 }] }],
    ]){
      const res = await save(GAMENIGHT, body);
      expect(res.status === 400, `${why} answered ${res.status}`);
    }
    const all = await read(GAMENIGHT);
    expect(!all.games.some(g => g.id.startsWith("refused-")), "a refused game was stored");
  });

  await check("shows and hub games read back together, and the app's list of shows has no hub game", async () => {
    const show = { id: "show-between-1", finishedAt: now - 25000, mode: "teams", difficulty: "easy", mix: "hindi", rounds: 3, songs: 3, cast: [{ name: "Reds", score: 4, members: ["Maya", "Jonas"] }, { name: "Blues", score: 2, members: ["Arun"] }] };
    const posted = await from(SITE, "/group/results", { method: "POST", body: JSON.stringify(show) });
    expect(posted.status === 200, `the app's own show answered ${posted.status}`);
    const { games, more } = await read(GAMENIGHT);
    expect(!more, "one page should hold everything");
    expect(same(games.map(g => [g.id, g.game]), [["charades-night-1", "charades"], ["show-between-1", "tuneteasers"], ["hub-site-1-game", "forehead"], ["hub-site-0-game", "forehead"]]), `read ${JSON.stringify(games.map(g => [g.id, g.game]))}`);
    expect(same(games[1], { id: show.id, game: "tuneteasers", mode: "teams", finishedAt: show.finishedAt, cast: show.cast }), `the show came back as ${JSON.stringify(games[1])}`);
    // In pages of one, each page starts where the one before stopped.
    const paged = [];
    for (let before = "", pages = 0; pages < 6; pages++){
      const page = await read(GAMENIGHT, `/group/games?limit=1${before}`);
      paged.push(...page.games.map(g => g.id));
      if (!page.more) break;
      before = `&before=${page.games.at(-1).finishedAt}`;
    }
    expect(same(paged, games.map(g => g.id)), `pages gave ${paged.join(", ")}`);
    const shows = (await read(SITE, "/group/results?limit=50")).results;
    expect(same(shows.map(r => r.id), [show.id]), `the app's shows are ${shows.map(r => r.id).join(", ")}`);
  });

  await check("a game past the results window is not served, and deleting the group deletes its games", async () => {
    worker.sql(`UPDATE game_results SET finished_at = ${now - 366 * 86400e3} WHERE result_id = 'hub-site-0-game'`);
    const kept = (await read(GAMENIGHT)).games.map(g => g.id);
    expect(!kept.includes("hub-site-0-game") && kept.includes("hub-site-1-game"), `after a year the list is ${kept.join(", ")}`);
    expect(worker.rows("SELECT COUNT(*) AS n FROM game_results")[0].n === 3, "the games are not where this check expects them");
    const gone = await fetch(worker.origin + "/api/group", { method: "DELETE", headers: { authorization: `Bearer ${made.owner}` } });
    expect(gone.status === 204, `the owner's delete answered ${gone.status}`);
    expect(worker.rows("SELECT COUNT(*) AS n FROM game_results")[0].n === 0, "the group's games outlived it");
  });
} finally {
  worker.stop();
}
console.log(results.join("\n"));
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
