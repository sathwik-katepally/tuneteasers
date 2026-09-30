# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against real browsers and the real song sources, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives in `e2e/` (plain Node ES modules on the `playwright` dev dependency; run `npx playwright install chromium webkit` once).
Every script serves `dist/` on a free local port the way Pages does, so run `npm run typecheck && npm run build` first.
Two profiles: `phone` is WebKit with the iPhone 13 device (390px), `desktop` is Chromium at 1440x900.
Test browsers are silent: Chromium runs with `--mute-audio` (`MUTE_ARGS`) and every `open()` context gets `silence()`, which zeroes element volume and puts a zero-gain node in front of each live AudioContext's destination; media time, paused/muted state and the engine's gain gate read exactly as unmuted, so the checks are unaffected.
Any new script that launches a browser should use both.
The landing page shows only on a first visit, so `open()` also adds `skipLanding()` (sets `tt_landing_seen` on every page load) unless called with `{ landing: true }`; scripts that make their own contexts add it themselves.
Only one suite runs at a time per machine: importing `e2e/harness.mjs` takes a lock at `/tmp/tuneteasers-e2e.lock` (shared by every worktree and agent session, which is why it is not under the per-session `TMPDIR`), and a second suite prints who holds it and waits.
A suite that is killed stops refreshing the lock, and the next one takes it over within a minute.
CI runners (`CI` set) skip the lock.

- `e2e/game.mjs` - plays a whole show through the UI: setup, hand-over, countdown, clip ladder (one "Hear 7s more"), every hint on one song (each shows and costs its points), Home and Resume mid-turn, the game menu, a right answer, a pass that the next contestant steals for half, a pass round the table that nobody knows (ended by "Nobody knows it" or the last contestant's "I don't know this one"), box office after each round, podium.
  The first contestant spends their "Heard it too much" skip (the title shows on the countdown, the same contestant gets a song from the same tier, the song is in `tt_tired` and not `tt_played`, the stub then reads Used), and a dead stream seeded into the saved queue checks that the stream-error skip is free and records nothing.
  It then checks the bookkeeping (every contestant's score equals their history, one history entry per turn, points in range, team members kept), that no page errors were thrown, and that no in-game screen scrolls at that size.
  Flags: `--profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both --difficulty=easy|medium|hard --rounds=3|5|8 --categories=item,mass --reduced --no-worker --shots=<dir>`; `--categories` picks those chips and checks that the game came from the corpus and every queued song carries one of the tags; `--shots` saves one screenshot per screen for review, and `--no-worker` makes the project's Worker unreachable (songs come from the mirror).
- `e2e/categories.mjs` (`npm run e2e:categories`) - the setup screen's song-category chips: Any clears the others, chips combine and persist across a reload, a thin chip is greyed with its count on Easy (a 48-turn Hindi 2000s show) and in Music-only (with the note), a chosen chip that turns thin can be turned off, saves without categories (or with junk ids) load as Any, and with `corpus.json` unreachable the chips stay off and a categories game reports a load error instead of falling back to untagged songs.
- `e2e/migrate.mjs` - seeds a `tuneteasers_v6` save from the previous release with real Saavn tracks, resumes it, plays a turn and checks names, rescaled scores, settings mapping and that the old key is dropped; then feeds junk into the old key and expects a clean home screen.
- `e2e/autoplay.mjs` - emulates iOS's per-element autoplay rule in Chromium: the hand-over tap's prime must let the countdown start the clip, and a stricter browser must get a working "Tap to play" fallback; also covers End game.
- `e2e/offline.mjs` - aborts every song source and expects a visible error on the home screen and the `crate` line in the `?debug=1` overlay.
- `e2e/ladder.mjs` - one turn through every rung and Replay, measured on the media clock: the engine's `window.__ttClips` records each clip's media position when it starts playing and once its pause settles, and a 10ms sampler of audible audio (element playing and unmuted, gate open) independently counts the stretches heard.
  `--window-at=0` serves only the verified windows that start at 0s, where no seek is needed to reach the window, so it catches a first clip that resumes from wherever the hand-over prime left the element instead of seeking.
  The expected spans come from the difficulty's ladder in `src/lib/config.ts`: Easy's rungs must cover 0-5s, 5-12s and 12-20s of the window and Replay 0-20s, Music-only's 0-5s and 5-12s and Replay 0-12s (within 0.15s: Easy's stop rides a JS timer a busy machine can delay), the seams must not repeat or skip more than 80ms, no rung past the ladder may be offered, Music-only must stay inside its verified interval, and the first clip must not sound before the listening screen is fully faded in, with "Now playing" and the clip bar starting within 150ms of the sound.
  It prints the measured spans and the hand-off timeline.
  Flags: `--profile=phone|desktop --difficulty=easy|medium|hard --mix=bolly|telugu|both --log`; run it for both profiles with Easy and Medium.
- `e2e/safe-snips.mjs` (`--profile=phone|desktop`, default both) - WebKit phone and Chromium desktop play Easy and Music-only through the final rung of each one's ladder and replay, resume saves written by the MusiCNN 12-second and the 20- and 10-second releases (the game must rebind to the current index's windows and keep its score), then replace the local index with missing, mismatched-ID, old-schema (v1, v2, v3), crossed (an accepted version whose entries carry the other version's method), unknown-version, wrong-length (10s, 20s) and stale variants to confirm the visible shortage state.
  It checks whatever index the build serves (`dist/snips.json`); to check the v5 switch, copy a v5 index over `dist/snips.json` after building (the 262-song fixture from the switch, say) and run it again, along with `e2e/ladder.mjs`.
  It first checks that `public/snips.json` itself is a current-schema index of `SNIP_WINDOW_SEC` windows.
- `e2e/group-sync.mjs` (`npm run e2e:group`) - desktop Chromium finds no group card on the home screen and makes a group from the menu's "Phone group" (importing its own played and tired history, each as its kind) and phone WebKit joins through the `#join` link; a song played on one, or skipped as heard too much (kept by the group as `tired`), is left out of the other's next crate, the desktop's finished show appears in the phone's Past shows, the phone keeps playing with the Worker unreachable and sends its queued plays when it is back, and the owner's delete makes the invite answer 403.
  It starts its own `wrangler dev` with a fresh local D1 and reroutes the deployed Worker host to it; `--worker=<origin>` points it at a deployed Worker instead (the preview one, see docs/group-sync.md), and `--shots=<dir>` saves the group screens.
- `e2e/group-edge.mjs` (`npm run e2e:group-edge`) - timing cases the journey cannot hit on purpose, driving `src/lib/group.ts` through the Vite dev server in Chromium against a local `wrangler dev`: switching groups while the old group's upload is in flight, a cooldown read after a failed one, an idle-expired group's invite (403, and a write cannot revive it), and a malformed `#join=` link.
- `e2e/landing.mjs` (`npm run e2e:landing -- --profile=phone|desktop --shots=<dir>`) - the landing page and quick setup: a first visit shows the landing with the clip ladder from config and no scrolling at 320-430px phones or 1024-1440px desktops, "Pass one phone" and "Buzz in from every phone" land on setup with that mode picked, Start stays in view with every setting open (320-430px, 1024-1440px), a reload lands on setup, the menu's About brings the landing back, "Back to the start" from the phone join screen returns to the landing or setup depending on where the visitor came from, a `#room=` link skips it and shows its code as fixed text with the name focused, a `#join=` link opens the group screen, and a v7 saved game shows Resume with the setup folded away.
- `e2e/journeys.mjs` (`npm run e2e:journeys -- --shots=<dir>`) - the UX audit's count of what a first-timer taps, reads and decides before the first song (phone and desktop, both modes): words over every screen before the first song (budget 180; the pre-simplification setup read 285), choices on the busiest screen (budget 12, was 20; a radio group counts as one) and taps (3); a returning player must start in one tap.
- `e2e/room.mjs` (`npm run e2e:room`) - a buzz-in room with a desktop Chromium host (or `--host=phone`, and `--difficulty=medium` for a Music-only show on its shorter ladder) and three WebKit iPhones: the big-screen lobby (QR at least 240px) and the join tag during play (desktop host only), a room link's fixed code and focused name, buzz order, scoring, the ladder after misses, the answer clock, reconnects, "Heard it too much" votes, host skips and the skip cap, podium, and that no phone receives a title before its reveal or any stream URL (docs/room-mode.md).
  It starts its own `wrangler dev` and proxies the room WebSockets to it, recording every frame; `--worker=<origin>` uses a deployed Worker, `--shots=<dir>` saves every screen.
- `e2e/room-norepeat.mjs` (`npm run e2e:room-norepeat`) - no repeats in buzz-in rooms: seeded phone histories reach only the host, the room's payload caps, crates without the seated phones' songs across two rooms, revealed and vote-skipped songs in each phone's own history, reconnects and a mid-show joiner (docs/room-mode.md, No repeats).
- `e2e/room-background.mjs` (`npm run e2e:room-background`) - a WebKit host goes to the background while its socket dies without a close (iOS), a phone joins, and the host must reconnect and show the player when it comes back (docs/room-mode.md, Reconnects).
- `node scripts/corpus-e2e.cjs [repo] [local-worker-origin]` - the corpus tier: games in each language resolve ids through a local `wrangler dev` worker (the deployed worker host is rerouted to it), through the deployed worker, and with no batch endpoint at all (must fall back to `source: "saavn"`); checks every queue track's corpus film/year/tier and the reveal; includes a phone-width WebKit pass.

Package scripts: `npm run e2e:game -- --profile=desktop`, `e2e:categories`, `e2e:ladder`, `e2e:migrate`, `e2e:autoplay`, `e2e:offline`, `e2e:snips`, `e2e:group`, `e2e:group-edge`, `e2e:room`, `e2e:room-norepeat`, `e2e:room-background`, `e2e:landing`, `e2e:journeys`.
A release run is the matrix of `game.mjs` over both profiles, both modes, all three difficulties and all three language mixes (not every combination, but each value at least once per profile), one `--reduced` run, one `--no-worker` run, one `--categories=item` and one `--categories=mass` run, plus the other scripts.
Playback modes asserted are `snip | plain` (`window.__ttLastMode`); Easy must report `plain`, while Medium and Hard must report `snip` or show a safe-clip shortage.
Gotchas: screens cross-fade out through `AnimatePresence`, so after a click wait for the old button to detach before looking for the next screen; seed localStorage from a non-app page on the same origin (`/seed.html` 404s, which is fine) so the app's own first save cannot race the seeding.

### E2E in CI

`.github/workflows/e2e.yml` runs the key suites on every pull request, one job per suite in parallel (about 3-5 minutes wall clock): a pass-the-phone game on each profile, safe-snips and the ladder on each profile, the buzz room against a local `wrangler dev`, and the landing and journeys suites.
`.github/workflows/e2e-release.yml` runs the rest of the release matrix above on pushes to main, nightly (02:30 UTC) and on demand, and alerts through ntfy when it fails; category games play Easy there, since in Music-only the item and mass chips are too thin to pick.
The shared steps (deps, build, Playwright browsers cached per version) are in `.github/actions/e2e-setup`.
The suites play real songs from the corpus through the deployed Worker and the Saavn CDN; the song draw is random, so recorded responses would rarely match a run and are not used.

Which runner a suite gets is decided by where its browser plays these AAC/MP4 streams in real time, measured on the runners in September 2026:
- Linux WebKit (GStreamer) cannot resume after a seek once a stream has played: `readyState` stays at 2 while `currentTime` runs on in silence, with local or CDN files, PulseAudio, either AAC decoder and playbin3 alike.
  Every Music-only clip and ladder rung seeks, so phone suites that play songs run on `macos-latest`, where WebKit uses AVFoundation like an iPhone.
- Chromium on the macOS runners plays media at about half speed (the same with `--disable-audio-output` or Google Chrome), so a 20-second Easy replay outlasts the suites' waits.
  Desktop suites run on `ubuntu-latest`, where Playwright's own Chromium decodes AAC and plays in real time, so no Chrome channel is needed.
- The buzz room runs on Linux: only its desktop host plays audio, and the WebKit phones there only render and send frames.
- Two checks stay off CI because the 3-core macOS runners are too loaded for them: the phone Easy ladder (its 150ms "Now playing" hand-off check missed by 170-290ms in 2 of 5 runs) and the buzz room with a phone host (4 WebKit pages; a phone's "You're in" timed out in 2 of 3 runs). Run them locally.
- A fresh macOS runner indexes its disk for Spotlight for the first minutes (load averages above 20 on 3 cores), which starves the timers the hand-off checks measure; the setup action turns indexing off.

The older ad-hoc scripts in `/tmp/tt-e2e` (and the obsolete on-device pipeline suites `dsp.js`, `pick.js`, `vadtest.js`, `ml*.js`) drove the pre-cinema UI and no longer apply.

## Deploy (GitHub Pages via Actions)

`.github/workflows/deploy.yml` runs on every push to main: its `worker` job applies the D1 migrations (`wrangler d1 migrations apply DB --remote`) and deploys the Worker, then the `deploy` job checks TypeScript, builds with Vite, and deploys `dist/` to Pages; Pages is configured with `build_type=workflow`.
The Worker goes first so the site never ships ahead of the API it calls; migrations must stay additive so the live site keeps working against the new schema.
The `worker` job uses the repo secrets `CLOUDFLARE_API_TOKEN` (Workers and D1 edit) and `CLOUDFLARE_ACCOUNT_ID`, set from Automic Vault (`av inject +CLOUDFLARE_API_TOKEN -- sh -c 'printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN'`).
`.github/workflows/verify.yml` runs the same typecheck and build on pull requests, plus a Worker `wrangler deploy --dry-run` and the migrations against a throwaway local D1.
`.github/workflows/e2e.yml` runs the browser suites (see E2E in CI above).
`vite.config.js` sets `base: "./"` so the build works under the `/tuneteasers/` project path.
After pushing, verify the workflow succeeded (`gh run watch` or `gh run list`) and smoke-test the live URL.

## Worker (Cloudflare)

`worker/` serves three things: the private group sync API backed by D1 (`src/group.js`, see docs/group-sync.md), buzz-in rooms as one Durable Object per room (`src/rooms.js`, `src/room.js`, see docs/room-mode.md), and a self-hosted JioSaavn search API (`src/saavn.js`), deployed to https://tuneteasers-saavn.sathwik-katepally.workers.dev on the free Workers plan.
It exists because the public mirrors come and go (saavn.dev died in 2026); it is the first entry in `SAAVN_BASES` (client and `scripts/build-snips.mjs`).
It serves `GET /api/search/songs?query=&limit=&page=` (the fallback search tier) and `GET /api/songs?ids=a,b,c` (batch song details, at most 50 ids; how the client and `scripts/build-snips.mjs` resolve corpus ids to streams), plus `/health`, calling JioSaavn's own `api.php` and decrypting `encrypted_media_url` (DES-ECB, the web player's public key) into `aac.saavncdn.com` stream URLs.
Responses use the saavn.dev shape (the subset the client reads), so any saavn.dev-compatible mirror can sit behind it in `SAAVN_BASES` as a fallback; the public mirror serves both routes, so the client keeps working when a new worker route is not deployed yet (the worker answers 404 and the client moves to the next base).
Successful responses are cached at the edge for 6 hours.

CI deploys it (see above); do not deploy production by hand.
Test locally with `npx wrangler d1 migrations apply DB --local && npx wrangler dev`, or deploy the preview copy with `--env preview`.

## Catalog refresh CI

### Landing data commits

main has a ruleset that requires a passing `verify` check, and in practice it only lets commits in through a merged pull request: a direct push is refused even when the commit already carries a passing `verify`.
A pull request opened with the workflow's `GITHUB_TOKEN` starts no workflows, so the refresh workflows land their commit with `scripts/land-bot-commit.sh`: it rebases on main, pushes the commit to a `bot/data-<run>` branch, opens a PR, dispatches `verify.yml` on that branch (a dispatch is the one event `GITHUB_TOKEN` may start), squash-merges the PR once it passes, and dispatches `deploy.yml`, since the merge starts no deploy either.
A PR whose `verify` fails stays open for a person to look at, and the workflow's alert fires.
The jobs that commit need `contents`, `pull-requests` and `actions: write`, and the repo setting "Allow GitHub Actions to create and approve pull requests" must stay on; on any branch but main the script just pushes.

`.github/workflows/refresh-catalog.yml` runs `scripts/build-catalog.mjs` weekly (Mon 03:00 UTC) and commits `public/catalog.json` if changed and lands it on main (see Landing data commits).
The script must stay sequential with delays (iTunes rate limit) and refuses to write a catalog with fewer than 100 tracks.
The script imports its search terms and `EXCLUDE_RX` from `src/lib/constants.js`, so it shares the page-side filters described in docs/song-loading.md.

## Corpus refresh CI

`.github/workflows/refresh-corpus.yml` runs `scripts/build-corpus.mjs` weekly (Tue 02:00 UTC) and commits `public/corpus.json` if changed and lands it on main.
Play counts move every week, so the file practically always changes.
When it does, the `snips` job dispatches `refresh-snips.yml` (`gh workflow run`), so the snips index scores the newly added songs the same night.
The script calls the Wikidata SPARQL endpoint (two queries per configured language, ~1 minute total), JioSaavn's `api.php` (a few hundred playlist fetches and roughly one title search per compilation copy, at concurrency 4) and English Wikipedia for the song categories (one title lookup per 50 candidate titles and one raw article per film, about 1,200); a full build takes about 15 minutes.
It refuses to write a corpus with fewer than `minSongsPerLanguage` songs in either language, or with a song category below its `minTagged`, so a broken upstream leaves the last good corpus in place.
Run it locally with `CORPUS_CACHE=<dir>` to cache upstream responses across reruns and `CORPUS_REPORT=<file>` for a per-song decision log (the input for hand checks).

## Snips refresh CI

`.github/workflows/refresh-snips.yml` runs `scripts/build-snips.mjs` nightly (04:30 UTC; the weekly corpus refresh also dispatches it) and commits `public/snips.json` and `scripts/voice-curves.json` if changed and lands it on main.
Its `plan` job counts the corpus songs without vocal-stem curves (`SNIP_PLAN=1`, no network) and starts one scoring runner per 35 of them, at most 40 and 20 at a time; a night with nothing to score skips scoring and only refreshes the index.
Each runner scores its share (`SNIP_SHARD=i/n`, at most `limit` songs) and stops taking songs after 5 hours (`SNIP_BUDGET_MIN`), well inside GitHub's 6-hour job limit, so whatever it scored is kept; the rest wait for the next night.
A `merge` job on the branch tip combines the shards' curves (`SNIP_MERGE=<dir>`), judges every corpus song from them, prints the curve coverage, the pass rate, entries per language/tier and the calibration, and commits.
Until the curves cover 95% of the corpus it publishes the previous v4 (MusiCNN) index with a fresh build time, so Music-only keeps working; from the first run past 95% it publishes the v5 index judged from the curves, and keeps publishing v5 after that (docs/audio.md).
A failure alert pages only for runs on main; a runner that fails only leaves its songs for the next night.
The scorer resolves corpus IDs to streams through the worker's batch endpoint (mirror fallback), then hands each song to `scripts/vocal-curve.py`, one long-lived Python process per runner (pinned in `scripts/requirements-snips.txt`: CPU PyTorch, `demucs`, `audio-separator`, `faster-whisper`; ffmpeg decodes), with the model weights (~2 GB) cached between runs under `~/.cache/tt-snips-models`.
On a 4-core runner a song takes about 4 minutes (htdemucs about 1.7, Whisper about 2) plus about 3 minutes per RoFormer check, so a full corpus takes two or three nights and a week of new songs a few runners for an hour.
RoFormer is too slow to run on whole songs there (about 30 minutes per song), which is why it only checks candidate windows.
Only songs without curves are fetched, new corpus IDs first; every song with curves is judged from them on each run, so the scorer never rescans a recording.
Changing a separator, the Whisper model or the measurement means new curve names in `scripts/build-snips.mjs` (`CURVE_METHOD` and its siblings) and a new index version: every song is scored again under them, and the old curves stay in the store.
The resolver tries both Saavn endpoints with short retries and fails with an endpoint summary after three empty corpus batches.
It refuses to write fewer than 80 entries.
The September 2026 switch from MusiCNN seeded the store with the curves of the 262 songs used to choose the separators (docs/audio.md has that comparison).
Run it locally with `SNIP_PYTHON=<venv>/bin/python`; `SNIP_CORPUS=<file>` limits it to a corpus subset.
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
