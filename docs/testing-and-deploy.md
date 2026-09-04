# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against a real browser, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives outside the repo at `/tmp/tt-e2e` (plain Node scripts, `playwright` npm package, Chromium already installed).
Scripts serve `dist/` on a local port with correct MIME types and drive the full flow: start game → snippet → reveal → score.

- `e2e.js` - core flow; `--block-saavn` / `--block-catalog` flags abort those network tiers to test each fallback.
- `features.js` - artist blocking, unblock, queue trimming, played-map format and cooldown ordering.
- `features2.js` - era filter chips and filtering, hint flow, half-point scoring, persistence.
- `snips.js` - stubbed snips.json and Saavn responses; asserts a verified track plays mode "snip" seeked to its window and an unverified one plays "muffle".
- `dupes.js` - builds a crate on the Saavn tier and the catalog tier and asserts no two queue entries share a `songKey` (keeps a synced copy of the key function).
- `webkit-local.js` - iPhone-emulated WebKit run against the local build; asserts a fast cue and a valid mode.
- `live*.js` - smoke tests against the production URL.

Playback modes asserted by the suites are `snip | muffle | plain` (`window.__ttLastMode`); no ML/model network requests should ever appear.
The old on-device pipeline suites `dsp.js`, `pick.js`, `vadtest.js`, and `ml*.js` are obsolete and no longer run.

Run `npm run build` first; the scripts read `dist/`.
Gotchas: buttons with the `.pulse` animation need `{ force: true }` clicks; state persists via a Preact effect, so after a click, `waitForFunction` on localStorage before reading it.

## Deploy (GitHub Pages via Actions)

`.github/workflows/deploy.yml` builds with Vite and deploys `dist/` to Pages on every push to main; Pages is configured with `build_type=workflow`.
`vite.config.js` sets `base: "./"` so the build works under the `/tuneteasers/` project path.
After pushing, verify the workflow succeeded (`gh run watch` or `gh run list`) and smoke-test the live URL.

## Catalog refresh CI

`.github/workflows/refresh-catalog.yml` runs `scripts/build-catalog.mjs` weekly (Mon 03:00 UTC) and commits `public/catalog.json` if changed, which in turn triggers a deploy.
The script must stay sequential with delays (iTunes rate limit) and refuses to write a catalog with fewer than 100 tracks.
Keep the script's filters in sync with the page-side filters described in docs/song-loading.md.

## Snips refresh CI

`.github/workflows/refresh-snips.yml` runs `scripts/build-snips.mjs` weekly (offset from the catalog refresh) and commits `public/snips.json` if changed, which in turn triggers a deploy.
The scorer runs the MusiCNN VAD in a Playwright Chromium page against local assets (`scripts/vad-assets/`), is incremental (existing entries by key are reused), drops entries with winMax >= 0.40, and refuses to write fewer than 80 entries.
The client tolerates a missing snips.json, so a failed refresh degrades to muffle-mode playback rather than breaking the game.

## Monitoring

### Workflow failure alerts

Every workflow (`deploy.yml`, `refresh-catalog.yml`, `refresh-snips.yml`) ends in an `alert` job that `needs` the other job and runs on `if: failure()`.
It POSTs the run URL to `https://ntfy.sh/$NTFY_TOPIC` with the title `<repo>/<workflow> failed`.
`failure()` is false for cancelled runs, so a deploy superseded by a newer push stays quiet.
The topic is the shared ops topic (`~/.config/ops/secrets.env`, `OPS_NTFY_TOPIC`), set with `gh secret set NTFY_TOPIC --repo sathwik-katepally/tuneteasers --body <topic>`.
A failed scheduled refresh is not an outage (the client degrades without a fresh catalog or snips index), but the alert is how a broken iTunes filter or a rate-limit change gets noticed at all.

### Web Analytics (dashboard step still open)

The beacon is wired but dormant: the `cloudflareBeacon` plugin in `vite.config.js` injects the Cloudflare Web Analytics `<script>` into `index.html` only when `CF_WEB_ANALYTICS_TOKEN` is set at build time, and `deploy.yml` feeds it from the repo variable of the same name.
Local builds have no token and ship no beacon.
The token is public by design (every visitor can read it out of the HTML), which is why it is a variable and not a secret.
Creating the site token needs an Account Analytics permission the wrangler OAuth token does not have (the API answers 403 on `/rum/site_info`), so:

1. Open https://dash.cloudflare.com/?to=/:account/web-analytics and select **Add a site**.
2. Enter the hostname `sathwik-katepally.github.io` (Web Analytics is keyed by hostname; the `/tuneteasers/` path is covered) and choose the manual (JS snippet) setup.
3. Copy the `token` value out of the `data-cf-beacon='{"token": "..."}'` attribute in the snippet shown.
4. Run `gh variable set CF_WEB_ANALYTICS_TOKEN --repo sathwik-katepally/tuneteasers --body <token>`.
5. Re-run the deploy (`gh workflow run deploy.yml --ref main`); the next build ships the beacon.
