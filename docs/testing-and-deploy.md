# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against real browsers and the real song sources, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives in `e2e/` (plain Node ES modules on the `playwright` dev dependency; run `npx playwright install chromium webkit` once).
Every script serves `dist/` on a free local port the way Pages does, so run `npm run typecheck && npm run build` first.
Two profiles: `phone` is WebKit with the iPhone 13 device (390px), `desktop` is Chromium at 1440x900.
Test browsers are silent: Chromium runs with `--mute-audio` (`MUTE_ARGS`) and every `open()` context gets `silence()`, which zeroes element volume and puts a zero-gain node in front of each live AudioContext's destination; media time, paused/muted state and the engine's gain gate read exactly as unmuted, so the checks are unaffected.
Any new script that launches a browser should use both.
The landing page shows only on a first visit, so `open()` also adds `skipLanding()` (sets `tt_landing_seen` on every page load) unless called with `{ landing: true }`; scripts that make their own contexts add it themselves.

- `e2e/game.mjs` - plays a whole show through the UI: setup, hand-over, countdown, clip ladder (one "Hear 7s more"), hint, Home and Resume mid-turn, the game menu, both one-tap scoring choices, box office after each round, podium.
  The first contestant spends their "Heard it too much" skip (the title shows on the countdown, the same contestant gets a song from the same tier, the song is in `tt_tired` and not `tt_played`, the stub then reads Used), and a dead stream seeded into the saved queue checks that the stream-error skip is free and records nothing.
  It then checks the bookkeeping (every contestant's score equals their history, one history entry per turn, points in range, team members kept), that no page errors were thrown, and that no in-game screen scrolls at that size.
  Flags: `--profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both --difficulty=easy|medium|hard --rounds=3|5|8 --categories=item,mass --reduced --no-worker --shots=<dir>`; `--categories` picks those chips and checks that the game came from the corpus and every queued song carries one of the tags; `--shots` saves one screenshot per screen for review, and `--no-worker` makes the project's Worker unreachable (songs come from the mirror).
- `e2e/categories.mjs` (`npm run e2e:categories`) - the setup screen's song-category chips: Any clears the others, chips combine and persist across a reload, a thin chip is greyed with its count on Easy (a 48-turn Hindi 2000s show) and in Music-only (with the note), a chosen chip that turns thin can be turned off, saves without categories (or with junk ids) load as Any, and with `corpus.json` unreachable the chips stay off and a categories game reports a load error instead of falling back to untagged songs.
- `e2e/migrate.mjs` - seeds a `tuneteasers_v6` save from the previous release with real Saavn tracks, resumes it, plays a turn and checks names, rescaled scores, settings mapping and that the old key is dropped; then feeds junk into the old key and expects a clean home screen.
- `e2e/autoplay.mjs` - emulates iOS's per-element autoplay rule in Chromium: the hand-over tap's prime must let the countdown start the clip, and a stricter browser must get a working "Tap to play" fallback; also covers End game.
- `e2e/offline.mjs` - aborts every song source and expects a visible error on the home screen and the `crate` line in the `?debug=1` overlay.
- `e2e/ladder.mjs` - one turn through every rung and Replay, measured on the media clock: the engine's `window.__ttClips` records each clip's media position when it starts playing and once its pause settles, and a 10ms sampler of audible audio (element playing and unmuted, gate open) independently counts the stretches heard.
  The expected spans come from the difficulty's ladder in `src/lib/config.ts`: Easy's rungs must cover 0-5s, 5-12s and 12-20s of the window and Replay 0-20s, Music-only's 0-5s and 5-12s and Replay 0-12s (within 0.15s: Easy's stop rides a JS timer a busy machine can delay), the seams must not repeat or skip more than 80ms, no rung past the ladder may be offered, Music-only must stay inside its verified interval, and the first clip must not sound before the listening screen is fully faded in, with "Now playing" and the clip bar starting within 150ms of the sound.
  It prints the measured spans and the hand-off timeline.
  Flags: `--profile=phone|desktop --difficulty=easy|medium|hard --mix=bolly|telugu|both --log`; run it for both profiles with Easy and Medium.
- `e2e/safe-snips.mjs` - WebKit phone and Chromium desktop play Easy and Music-only through the final rung of each one's ladder and replay, resume saves written by the 20- and 10-second releases (the game must rebind to 12s windows and keep its score), then replace the local index with missing, mismatched-ID, old-schema (v1, v2, v3), wrong-length (10s, 20s) and stale variants to confirm the visible shortage state.
  It first checks that `public/snips.json` itself is a current-schema index of `SNIP_WINDOW_SEC` windows.
- `e2e/group-sync.mjs` (`npm run e2e:group`) - desktop Chromium makes a group (importing its own played and tired history, each as its kind) and phone WebKit joins through the `#join` link; a song played on one, or skipped as heard too much (kept by the group as `tired`), is left out of the other's next crate, the desktop's finished show appears in the phone's Past shows, the phone keeps playing with the Worker unreachable and sends its queued plays when it is back, and the owner's delete makes the invite answer 403.
  It starts its own `wrangler dev` with a fresh local D1 and reroutes the deployed Worker host to it; `--worker=<origin>` points it at a deployed Worker instead (the preview one, see docs/group-sync.md), and `--shots=<dir>` saves the group screens.
- `e2e/group-edge.mjs` (`npm run e2e:group-edge`) - timing cases the journey cannot hit on purpose, driving `src/lib/group.ts` through the Vite dev server in Chromium against a local `wrangler dev`: switching groups while the old group's upload is in flight, a cooldown read after a failed one, an idle-expired group's invite (403, and a write cannot revive it), and a malformed `#join=` link.
- `e2e/landing.mjs` (`npm run e2e:landing -- --profile=phone|desktop --shots=<dir>`) - the landing page: a first visit shows it with the clip ladder from config and no scrolling at 320-430px phones or 1024-1440px desktops, "Set up a game" and a reload land on setup, the About button brings it back, "Back to the start" from the phone join screen returns to the landing or setup depending on where the visitor came from, `#room=` and `#join=` links skip it, and a v7 saved game or a v6 save lands on setup.
- `e2e/tickets.mjs` (`npm run e2e:tickets`) - personal tickets (docs/tickets.md): a passkey through a Chromium virtual authenticator at iPhone size, the roster chips and per-person exclusion on a WebKit phone and a desktop, a room host's crate and history writes, recovery on a fresh browser, the move link, the offline outbox, deletion and the Worker's guards.
  It starts its own `wrangler dev` with a fresh local D1; `--worker=<origin>` points it at a deployed Worker, `--shots=<dir>` saves every screen.
- `e2e/room.mjs` (`npm run e2e:room`) - a buzz-in room with a desktop Chromium host (or `--host=phone`, and `--difficulty=medium` for a Music-only show on its shorter ladder) and three WebKit iPhones: buzz order, scoring, the ladder after misses, the answer clock, reconnects, "Heard it too much" votes, host skips and the skip cap, podium, and that no phone receives a title before its reveal or any stream URL (docs/room-mode.md).
  It starts its own `wrangler dev` and proxies the room WebSockets to it, recording every frame; `--worker=<origin>` uses a deployed Worker, `--shots=<dir>` saves every screen.
- `node scripts/corpus-e2e.cjs [repo] [local-worker-origin]` - the corpus tier: games in each language resolve ids through a local `wrangler dev` worker (the deployed worker host is rerouted to it), through the deployed worker, and with no batch endpoint at all (must fall back to `source: "saavn"`); checks every queue track's corpus film/year/tier and the reveal; includes a phone-width WebKit pass.

Package scripts: `npm run e2e:game -- --profile=desktop`, `e2e:categories`, `e2e:ladder`, `e2e:migrate`, `e2e:autoplay`, `e2e:offline`, `e2e:snips`, `e2e:group`, `e2e:group-edge`, `e2e:room`, `e2e:landing`.
A release run is the matrix of `game.mjs` over both profiles, both modes, all three difficulties and all three language mixes (not every combination, but each value at least once per profile), one `--reduced` run, one `--no-worker` run, one `--categories=item` and one `--categories=mass` run, plus the other scripts.
Playback modes asserted are `snip | plain` (`window.__ttLastMode`); Easy must report `plain`, while Medium and Hard must report `snip` or show a safe-clip shortage.
Gotchas: screens cross-fade out through `AnimatePresence`, so after a click wait for the old button to detach before looking for the next screen; seed localStorage from a non-app page on the same origin (`/seed.html` 404s, which is fine) so the app's own first save cannot race the seeding.

The older ad-hoc scripts in `/tmp/tt-e2e` (and the obsolete on-device pipeline suites `dsp.js`, `pick.js`, `vadtest.js`, `ml*.js`) drove the pre-cinema UI and no longer apply.

## Deploy (GitHub Pages via Actions)

`.github/workflows/deploy.yml` runs on every push to main: its `worker` job applies the D1 migrations (`wrangler d1 migrations apply DB --remote`) and deploys the Worker, then the `deploy` job checks TypeScript, builds with Vite, and deploys `dist/` to Pages; Pages is configured with `build_type=workflow`.
The Worker goes first so the site never ships ahead of the API it calls; migrations must stay additive so the live site keeps working against the new schema.
The `worker` job uses the repo secrets `CLOUDFLARE_API_TOKEN` (Workers and D1 edit) and `CLOUDFLARE_ACCOUNT_ID`, set from Automic Vault (`av inject +CLOUDFLARE_API_TOKEN -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN'`).
`.github/workflows/verify.yml` runs the same typecheck and build on pull requests, plus a Worker `wrangler deploy --dry-run` and the migrations against a throwaway local D1.
`vite.config.js` sets `base: "./"` so the build works under the `/tuneteasers/` project path.
After pushing, verify the workflow succeeded (`gh run watch` or `gh run list`) and smoke-test the live URL.

## Worker (Cloudflare)

`worker/` serves four things: the private group sync API backed by D1 (`src/group.js`, see docs/group-sync.md), personal tickets with passkeys (`src/people.js`, see docs/tickets.md), buzz-in rooms as one Durable Object per room (`src/rooms.js`, `src/room.js`, see docs/room-mode.md), and a self-hosted JioSaavn search API (`src/saavn.js`), deployed to https://tuneteasers-saavn.sathwik-katepally.workers.dev on the free Workers plan.
It exists because the public mirrors come and go (saavn.dev died in 2026); it is the first entry in `SAAVN_BASES` (client and `scripts/build-snips.mjs`).
It serves `GET /api/search/songs?query=&limit=&page=` (the fallback search tier) and `GET /api/songs?ids=a,b,c` (batch song details, at most 50 ids; how the client and `scripts/build-snips.mjs` resolve corpus ids to streams), plus `/health`, calling JioSaavn's own `api.php` and decrypting `encrypted_media_url` (DES-ECB, the web player's public key) into `aac.saavncdn.com` stream URLs.
Responses use the saavn.dev shape (the subset the client reads), so any saavn.dev-compatible mirror can sit behind it in `SAAVN_BASES` as a fallback; the public mirror serves both routes, so the client keeps working when a new worker route is not deployed yet (the worker answers 404 and the client moves to the next base).
Successful responses are cached at the edge for 6 hours.

CI deploys it (see above); do not deploy production by hand.
Test locally with `npx wrangler d1 migrations apply DB --local && npx wrangler dev`, or deploy the preview copy with `--env preview`.

## Catalog refresh CI

`.github/workflows/refresh-catalog.yml` runs `scripts/build-catalog.mjs` weekly (Mon 03:00 UTC) and commits `public/catalog.json` if changed, which in turn triggers a deploy.
The script must stay sequential with delays (iTunes rate limit) and refuses to write a catalog with fewer than 100 tracks.
The script imports its search terms and `EXCLUDE_RX` from `src/lib/constants.js`, so it shares the page-side filters described in docs/song-loading.md.

## Corpus refresh CI

`.github/workflows/refresh-corpus.yml` runs `scripts/build-corpus.mjs` weekly (Tue 02:00 UTC) and commits `public/corpus.json` if changed, which triggers a deploy.
Play counts move every week, so the file practically always changes.
When it does, the `snips` job dispatches `refresh-snips.yml` (`gh workflow run`), so the snips index scores the newly added songs the same night.
The script calls the Wikidata SPARQL endpoint (two queries per configured language, ~1 minute total), JioSaavn's `api.php` (a few hundred playlist fetches and roughly one title search per compilation copy, at concurrency 4) and English Wikipedia for the song categories (one title lookup per 50 candidate titles and one raw article per film, about 1,200); a full build takes about 15 minutes.
It refuses to write a corpus with fewer than `minSongsPerLanguage` songs in either language, or with a song category below its `minTagged`, so a broken upstream leaves the last good corpus in place.
Run it locally with `CORPUS_CACHE=<dir>` to cache upstream responses across reruns and `CORPUS_REPORT=<file>` for a per-song decision log (the input for hand checks).

## Snips refresh CI

`.github/workflows/refresh-snips.yml` runs `scripts/build-snips.mjs` weekly (Wed 04:30 UTC, after the corpus refresh, which also dispatches it on change) and commits `public/snips.json` if changed, which in turn triggers a deploy.
Scoring runs in a matrix of `shards` runners (1 on schedule), each scoring at most `limit` songs of its share into a partial index (`SNIP_SHARD=i/n`); a `merge` job combines them (`SNIP_MERGE=<dir>`), applies the size floor, prints the pass rate and entries per language/tier, and commits.
After a schema change, dispatch it with more runners, for example `gh workflow run refresh-snips.yml -f shards=12 -f limit=400`, so the whole corpus is rescored in one go; a runner that fails only leaves its songs for the next run.
A failure alert pages only for runs on main.
The scorer resolves corpus IDs to streams through the worker's batch endpoint (mirror fallback), then runs the MusiCNN VAD in a Playwright Chromium page against local assets (`scripts/vad-assets/`).
It reuses only valid entries of the current schema (v4) for the same source ID and writes 12-second intervals whose overlapping patches all pass the clean threshold.
Only songs with neither an index entry nor a stored voice curve are fetched and scored; every song with a curve is judged from it on each run, so the scorer never rescans a recording.
Each scheduled run scores at most 300 such IDs (a full-song dense scan takes 30 to 70 seconds per song) and records rejected IDs in `checked`.
Shards write their new curves next to their partial index, and the merge commits `public/snips.json` and `scripts/voice-curves.json` together.
Changing the model, patch geometry or extraction means a new `CURVE_METHOD` in `scripts/build-snips.mjs`: every song is scored again under it, and the old detector's curves stay in the store.
New IDs in the weekly corpus are prioritized using the previous index's `corpusIds` snapshot.
The resolver tries both Saavn endpoints with short retries and fails with an endpoint summary after three empty corpus batches; the existing workflow failure alert remains active.
It refuses to write fewer than 80 entries.
An index of an earlier schema never authorizes anything as it is, but its verified windows at least `SNIP_WINDOW_SEC` long carry over as the first `SNIP_WINDOW_SEC` seconds of each (the same every-patch check, so any stretch of one is clean): automatically while the output file still holds the older schema, or from `SNIP_PRIOR=<old-index>`.
The v4 rescore (12-second windows, September 2026) carried over the 142 songs with verified 20-second windows and raised verified songs from 142 of 2,418 (6%) to 527 (22%): Hindi easy/medium/hard 119/106/76 and Telugu 79/88/59, up from 34/32/17 and 17/22/20.
The client fails closed with a clear Music-only shortage if the index is missing or inadequate.

## Monitoring

### Workflow failure alerts

The production workflows (`deploy.yml`, including its Worker job, `refresh-catalog.yml`, `refresh-snips.yml`) end in an `alert` job that `needs` the other jobs and runs on `if: failure()` (for `refresh-snips.yml`, only on main).
It POSTs the run URL to `https://ntfy.sh/$NTFY_TOPIC` with the title `<repo>/<workflow> failed`.
`failure()` is false for cancelled runs, so a deploy superseded by a newer push stays quiet.
The topic is the shared ops topic (`~/.config/ops/secrets.env`, `OPS_NTFY_TOPIC`), set with `gh secret set NTFY_TOPIC --repo sathwik-katepally/tuneteasers --body <topic>`.
A failed scheduled refresh is not an outage (the client degrades without a fresh catalog or snips index), but the alert is how a broken iTunes filter or a rate-limit change gets noticed at all.

### Web Analytics

The `cloudflareBeacon` plugin in `vite.config.js` injects the Cloudflare Web Analytics `<script>` into `index.html` only when `CF_WEB_ANALYTICS_TOKEN` is set at build time, and `deploy.yml` feeds it from the repo variable of the same name (set, so production ships the beacon).
Local builds have no token and ship no beacon.
The token is public by design (every visitor can read it out of the HTML), which is why it is a variable and not a secret.
The site is registered in the dashboard under the hostname `sathwik-katepally.github.io` (https://dash.cloudflare.com/?to=/:account/web-analytics); the `/tuneteasers/` path is covered.
