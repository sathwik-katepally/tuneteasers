# Testing and deploy

## E2E testing (Playwright)

There is no unit test suite; verification is E2E against a real browser, per the project's bug-fix methodology (reproduce like an end user first).
The harness lives outside the repo at `/tmp/tt-e2e` (plain Node scripts, `playwright` npm package, Chromium already installed).
Scripts serve `dist/` on a local port with correct MIME types and drive the full flow: start game → snippet → reveal → score.

- `e2e.js` - core flow; `--block-saavn` / `--block-catalog` flags abort those network tiers to test each fallback.
- `features.js` - artist blocking, unblock, queue trimming, played-map format and cooldown ordering.
- `features2.js` - era filter chips and filtering, hint flow, half-point scoring, persistence.
- `live*.js` - smoke tests against the production URL.

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
