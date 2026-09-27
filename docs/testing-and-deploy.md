# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against real browsers and the real song sources, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives in `e2e/` (plain Node ES modules on the `playwright` dev dependency; run `npx playwright install chromium webkit` once).
Every script serves `dist/` on a free local port the way Pages does, so run `npm run typecheck && npm run build` first.
Two profiles: `phone` is WebKit with the iPhone 13 device (390px), `desktop` is Chromium at 1440x900.

- `e2e/game.mjs` - plays a whole show through the UI: setup, hand-over, countdown, clip ladder (one "Hear 5s"), hint, skip, Home and Resume mid-turn, the game menu, reveal with Got it and Missed, box office after each round, podium.
  It then checks the bookkeeping (every contestant's score equals their history, one history entry per turn, points in range, team members kept), that no page errors were thrown, and that no in-game screen scrolls at that size.
  Flags: `--profile=phone|desktop --mode=players|teams --mix=bolly|telugu|both --difficulty=easy|medium|hard --rounds=3|5|8 --reduced --shots=<dir>`; `--shots` saves one screenshot per screen for review.
- `e2e/migrate.mjs` - seeds a `tuneteasers_v6` save from the previous release with real Saavn tracks, resumes it, plays a turn and checks names, rescaled scores, settings mapping and that the old key is dropped; then feeds junk into the old key and expects a clean home screen.
- `e2e/autoplay.mjs` - emulates iOS's per-element autoplay rule in Chromium: the hand-over tap's prime must let the countdown start the clip, and a stricter browser must get a working "Tap to play" fallback; also covers End game.
- `e2e/offline.mjs` - aborts every song source and expects a visible error on the home screen and the `crate` line in the `?debug=1` overlay.

Package scripts: `npm run e2e:game -- --profile=desktop`, `e2e:migrate`, `e2e:autoplay`, `e2e:offline`.
A release run is the matrix of `game.mjs` over both profiles, both modes, all three difficulties and all three language mixes (not every combination, but each value at least once per profile), one `--reduced` run, plus the other three scripts.
Playback modes asserted are `snip | muffle | plain` (`window.__ttLastMode`); Easy must always report `plain`.
Gotchas: screens cross-fade out through `AnimatePresence`, so after a click wait for the old button to detach before looking for the next screen; seed localStorage from a non-app page on the same origin (`/seed.html` 404s, which is fine) so the app's own first save cannot race the seeding.

The older ad-hoc scripts in `/tmp/tt-e2e` (and the obsolete on-device pipeline suites `dsp.js`, `pick.js`, `vadtest.js`, `ml*.js`) drove the pre-cinema UI and no longer apply.

## Deploy (GitHub Pages via Actions)

`.github/workflows/deploy.yml` checks TypeScript, builds with Vite, and deploys `dist/` to Pages on every push to main; Pages is configured with `build_type=workflow`.
`.github/workflows/verify.yml` runs the same typecheck and build on pull requests.
`vite.config.js` sets `base: "./"` so the build works under the `/tuneteasers/` project path.
After pushing, verify the workflow succeeded (`gh run watch` or `gh run list`) and smoke-test the live URL.

## Saavn Worker (Cloudflare)

`worker/` is a self-hosted JioSaavn search API, deployed to https://tuneteasers-saavn.sathwik-katepally.workers.dev on the free Workers plan.
It exists because the public mirrors come and go (saavn.dev died in 2026); it is the first entry in `SAAVN_BASES` (client and `scripts/build-snips.mjs`).
It serves only `GET /api/search/songs?query=&limit=&page=` (plus `/health`), calling JioSaavn's own `api.php` and decrypting `encrypted_media_url` (DES-ECB, the web player's public key) into `aac.saavncdn.com` stream URLs.
Responses use the saavn.dev shape (the subset the client reads), so any saavn.dev-compatible mirror can sit behind it in `SAAVN_BASES` as a fallback.
Successful responses are cached at the edge for 6 hours.

Deploy is manual (it rarely changes): `cd worker && npm install && npx wrangler deploy`, using the local wrangler OAuth login.
Test locally with `npx wrangler dev`.

## Catalog refresh CI

`.github/workflows/refresh-catalog.yml` runs `scripts/build-catalog.mjs` weekly (Mon 03:00 UTC) and commits `public/catalog.json` if changed, which in turn triggers a deploy.
The script must stay sequential with delays (iTunes rate limit) and refuses to write a catalog with fewer than 100 tracks.
The script imports its search terms and `EXCLUDE_RX` from `src/lib/constants.js`, so it shares the page-side filters described in docs/song-loading.md.

## Snips refresh CI

`.github/workflows/refresh-snips.yml` runs `scripts/build-snips.mjs` weekly (offset from the catalog refresh) and commits `public/snips.json` if changed, which in turn triggers a deploy.
The scorer runs the MusiCNN VAD in a Playwright Chromium page against local assets (`scripts/vad-assets/`), is incremental (existing entries by key are reused), drops entries with winMax >= 0.40, and refuses to write fewer than 80 entries.
The client tolerates a missing snips.json, so a failed refresh degrades to muffle-mode playback rather than breaking the game.

## Monitoring

### Workflow failure alerts

The production workflows (`deploy.yml`, `refresh-catalog.yml`, `refresh-snips.yml`) end in an `alert` job that `needs` the other job and runs on `if: failure()`.
It POSTs the run URL to `https://ntfy.sh/$NTFY_TOPIC` with the title `<repo>/<workflow> failed`.
`failure()` is false for cancelled runs, so a deploy superseded by a newer push stays quiet.
The topic is the shared ops topic (`~/.config/ops/secrets.env`, `OPS_NTFY_TOPIC`), set with `gh secret set NTFY_TOPIC --repo sathwik-katepally/tuneteasers --body <topic>`.
A failed scheduled refresh is not an outage (the client degrades without a fresh catalog or snips index), but the alert is how a broken iTunes filter or a rate-limit change gets noticed at all.

### Web Analytics

The `cloudflareBeacon` plugin in `vite.config.js` injects the Cloudflare Web Analytics `<script>` into `index.html` only when `CF_WEB_ANALYTICS_TOKEN` is set at build time, and `deploy.yml` feeds it from the repo variable of the same name (set, so production ships the beacon).
Local builds have no token and ship no beacon.
The token is public by design (every visitor can read it out of the HTML), which is why it is a variable and not a secret.
The site is registered in the dashboard under the hostname `sathwik-katepally.github.io` (https://dash.cloudflare.com/?to=/:account/web-analytics); the `/tuneteasers/` path is covered.
