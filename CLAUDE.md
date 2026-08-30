# TuneTeasers

Pass-the-phone Bollywood/Telugu song-guessing party game.
Preact + Vite SPA, deployed by GitHub Actions to GitHub Pages at https://sathwik-katepally.github.io/tuneteasers/.

## Commands

- `npm run dev` - local dev server
- `npm run build` - production build to `dist/`
- `npm run build:catalog` - regenerate `public/catalog.json` from iTunes (slow; sequential requests to respect Apple's ~20 req/min rate limit)

## Hard rules

- All game data is device-local (localStorage); there are no accounts and no backend.
- Song streaming URLs must be https and pass `sanitizeTrack`; never render or play unsanitized API data.
- Every playback path must go through the audio engine in `src/lib/engine.js`; never create ad-hoc Audio elements elsewhere.
- Verify changes E2E with the Playwright harness before pushing (see docs/testing-and-deploy.md); pushes to main auto-deploy to production.

## Detailed docs (read on demand)

Read the matching doc before working in that area; skip otherwise.

- `docs/architecture.md` - module layout, state model, screens and phases
- `docs/song-loading.md` - 3-tier song sourcing, filters, era/artist/cooldown rules
- `docs/audio.md` - Web Audio vocal-muffle engine and playback session rules
- `docs/testing-and-deploy.md` - Playwright E2E harness, Pages deploy, catalog refresh CI
