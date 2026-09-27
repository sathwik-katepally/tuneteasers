# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against real browsers and the real song sources, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives in `e2e/` (plain Node ES modules on the `playwright` dev dependency; run `npx playwright install chromium webkit` once).
Every script serves `dist/` on a free local port the way Pages does, so run `npm run typecheck && npm run build` first.
Two profiles: `phone` is WebKit with the iPhone 13 device (390px), `desktop` is Chromium at 1440x900.

- `e2e/game.mjs` - plays a whole show through the UI: setup, hand-over, countdown, clip ladder (one "Hear 5s"), hint, Home and Resume mid-turn, the game menu, both one-tap scoring choices, box office after each round, podium.
  It then checks the bookkeeping (every contestant's score equals their history, one history entry per turn, points in range, team members kept), that no page errors were thrown, and that no in-game screen scrolls at that size.
  Flags: `--profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both --difficulty=easy|medium|hard --rounds=3|5|8 --reduced --no-worker --shots=<dir>`; `--shots` saves one screenshot per screen for review, and `--no-worker` makes the project's Worker unreachable (songs come from the mirror).
- `e2e/migrate.mjs` - seeds a `tuneteasers_v6` save from the previous release with real Saavn tracks, resumes it, plays a turn and checks names, rescaled scores, settings mapping and that the old key is dropped; then feeds junk into the old key and expects a clean home screen.
- `e2e/autoplay.mjs` - emulates iOS's per-element autoplay rule in Chromium: the hand-over tap's prime must let the countdown start the clip, and a stricter browser must get a working "Tap to play" fallback; also covers End game.
- `e2e/offline.mjs` - aborts every song source and expects a visible error on the home screen and the `crate` line in the `?debug=1` overlay.
- `e2e/safe-snips.mjs` - WebKit phone and Chromium desktop play Easy and Music-only through the final rung and replay, then replace the local index with missing, mismatched-ID, stale, and old-schema variants to confirm the visible shortage state.
- `e2e/group-sync.mjs` (`npm run e2e:group`) - desktop Chromium makes a group (importing its own history) and phone WebKit joins through the `#join` link; a song played on one is left out of the other's next crate, the desktop's finished show appears in the phone's Past shows, the phone keeps playing with the Worker unreachable and sends its queued plays when it is back, and the owner's delete makes the invite answer 403.
  It starts its own `wrangler dev` with a fresh local D1 and reroutes the deployed Worker host to it; `--worker=<origin>` points it at a deployed Worker instead (the preview one, see docs/group-sync.md), and `--shots=<dir>` saves the group screens.
- `e2e/group-edge.mjs` (`npm run e2e:group-edge`) - timing cases the journey cannot hit on purpose, driving `src/lib/group.ts` through the Vite dev server in Chromium against a local `wrangler dev`: switching groups while the old group's upload is in flight, a cooldown read after a failed one, an idle-expired group's invite (403, and a write cannot revive it), and a malformed `#join=` link.
- `node scripts/corpus-e2e.cjs [repo] [local-worker-origin]` - the corpus tier: games in each language resolve ids through a local `wrangler dev` worker (the deployed worker host is rerouted to it), through the deployed worker, and with no batch endpoint at all (must fall back to `source: "saavn"`); checks every queue track's corpus film/year/tier and the reveal; includes a phone-width WebKit pass.

Package scripts: `npm run e2e:game -- --profile=desktop`, `e2e:migrate`, `e2e:autoplay`, `e2e:offline`, `e2e:snips`, `e2e:group`, `e2e:group-edge`.
A release run is the matrix of `game.mjs` over both profiles, both modes, all three difficulties and all three language mixes (not every combination, but each value at least once per profile), one `--reduced` run, one `--no-worker` run, plus the other scripts.
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

`worker/` serves two things: the private group sync API backed by D1 (`src/group.js`, see docs/group-sync.md) and a self-hosted JioSaavn search API (`src/saavn.js`), deployed to https://tuneteasers-saavn.sathwik-katepally.workers.dev on the free Workers plan.
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
The script calls the Wikidata SPARQL endpoint (two queries per configured language, ~1 minute total) and JioSaavn's `api.php` (a few hundred playlist fetches and roughly one title search per compilation copy, at concurrency 4); a full build takes about 15 minutes.
It refuses to write a corpus with fewer than `minSongsPerLanguage` songs in either language, so a broken upstream leaves the last good corpus in place.
Run it locally with `CORPUS_CACHE=<dir>` to cache upstream responses across reruns and `CORPUS_REPORT=<file>` for a per-song decision log (the input for hand checks).

## Snips refresh CI

`.github/workflows/refresh-snips.yml` runs `scripts/build-snips.mjs` weekly (Wed 04:30 UTC, after the corpus refresh, which also dispatches it on change) and commits `public/snips.json` if changed, which in turn triggers a deploy.
The scorer resolves corpus IDs to streams through the worker's batch endpoint (mirror fallback), then runs the MusiCNN VAD in a Playwright Chromium page against local assets (`scripts/vad-assets/`).
It reuses only valid v2 entries for the same source ID and writes 10-second intervals whose overlapping patches all pass the clean threshold.
Each scheduled run scores at most 300 unexamined IDs and records rejected IDs in `checked`, so later runs advance through the corpus instead of rescoring the same failures.
New IDs in the weekly corpus are prioritized using the previous index's `corpusIds` snapshot.
The resolver tries both Saavn endpoints with short retries and fails with an endpoint summary after three empty corpus batches; the existing workflow failure alert remains active.
It refuses to write fewer than 80 entries.
`SNIP_HINTS=<old-v1-index> SNIP_MIGRATE_ONLY=1` is the one-time migration path: it rescans the old clean candidates continuously against the live recording, discards failures, and leaves other recordings for the normal scheduled full scan.
The client fails closed with a clear Music-only shortage if the index is missing or inadequate.

## Monitoring

### Workflow failure alerts

The production workflows (`deploy.yml`, including its Worker job, `refresh-catalog.yml`, `refresh-snips.yml`) end in an `alert` job that `needs` the other job and runs on `if: failure()`.
It POSTs the run URL to `https://ntfy.sh/$NTFY_TOPIC` with the title `<repo>/<workflow> failed`.
`failure()` is false for cancelled runs, so a deploy superseded by a newer push stays quiet.
The topic is the shared ops topic (`~/.config/ops/secrets.env`, `OPS_NTFY_TOPIC`), set with `gh secret set NTFY_TOPIC --repo sathwik-katepally/tuneteasers --body <topic>`.
A failed scheduled refresh is not an outage (the client degrades without a fresh catalog or snips index), but the alert is how a broken iTunes filter or a rate-limit change gets noticed at all.

### Web Analytics

The `cloudflareBeacon` plugin in `vite.config.js` injects the Cloudflare Web Analytics `<script>` into `index.html` only when `CF_WEB_ANALYTICS_TOKEN` is set at build time, and `deploy.yml` feeds it from the repo variable of the same name (set, so production ships the beacon).
Local builds have no token and ship no beacon.
The token is public by design (every visitor can read it out of the HTML), which is why it is a variable and not a secret.
The site is registered in the dashboard under the hostname `sathwik-katepally.github.io` (https://dash.cloudflare.com/?to=/:account/web-analytics); the `/tuneteasers/` path is covered.
