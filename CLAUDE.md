# TuneTeasers

Pass-the-phone Bollywood/Telugu song-guessing party game.
React 19 + TypeScript + Vite SPA, deployed by GitHub Actions to GitHub Pages at https://sathwik-katepally.github.io/tuneteasers/.

## Commands

- `npm run dev` - local dev server
- `npm run typecheck` - strict TypeScript check of the React UI
- `npm run build` - production build to `dist/`
- `npm run e2e:game -- --profile=phone|desktop ...` (and `e2e:migrate`, `e2e:autoplay`, `e2e:offline`) - Playwright E2E against `dist/`
- `npm run build:catalog` - regenerate `public/catalog.json` from iTunes (slow; sequential requests to respect Apple's ~20 req/min rate limit)
- `npm run build:snips` - regenerate `public/snips.json`, the offline-scored instrumental-window index (slow; scores songs in a Playwright Chromium page)
- `cd worker && npx wrangler deploy` - deploy the self-hosted JioSaavn search Worker (first entry in `SAAVN_BASES`)

## Hard rules

- All game data is device-local (localStorage); there are no accounts and no backend beyond the stateless JioSaavn search proxy in `worker/`.
- Song streaming URLs must be https and pass `sanitizeTrack`; never render or play unsanitized API data.
- Every playback path, sound effects included, must go through the audio engine in `src/lib/engine.js`; never create ad-hoc Audio elements or AudioContexts elsewhere.
- Gameplay numbers (clip ladder, points, bonus, hint cost, rounds) live only in `src/lib/config.ts`.
- Verify changes E2E with the Playwright harness in `e2e/` before pushing (see docs/testing-and-deploy.md); pushes to main auto-deploy to production.

## Detailed docs (read on demand)

Read the matching doc before working in that area; skip otherwise.

- `docs/architecture.md` - module layout, design system, state model, screens, phases and scoring
- `docs/song-loading.md` - 3-tier song sourcing, filters, era/artist/cooldown rules
- `docs/audio.md` - element playback modes, snips.json contract, playback session rules, autoplay priming, sound effects
- `docs/testing-and-deploy.md` - Playwright E2E harness, Pages deploy, catalog refresh CI
