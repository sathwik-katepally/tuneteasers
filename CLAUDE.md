# TuneTeasers

Bollywood/Telugu song-guessing party game: pass one phone around, or buzz in from everyone's phones while one screen plays.
React 19 + TypeScript + Vite SPA, deployed by GitHub Actions to GitHub Pages at https://sathwik-katepally.github.io/tuneteasers/.

## Commands

- `npm run dev` - local dev server
- `npm run typecheck` - strict TypeScript check of the React UI
- `npm run build` - production build to `dist/`
- `npm run e2e:game -- --profile=phone|desktop ...` (and `e2e:categories`, `e2e:ladder`, `e2e:migrate`, `e2e:autoplay`, `e2e:offline`, `e2e:snips`, `e2e:group`, `e2e:group-edge`, `e2e:room`, `e2e:room-norepeat`, `e2e:landing`, `e2e:journeys`) - Playwright E2E against `dist/`
- `npm run build:catalog` - regenerate `public/catalog.json` from iTunes (slow; sequential requests to respect Apple's ~20 req/min rate limit)
- `npm run build:snips` - regenerate `public/snips.json`, the offline-scored instrumental-window index (slow; scores songs in a Playwright Chromium page)
- `cd worker && npx wrangler dev` - run the Worker (Saavn proxy, group API, buzz-in rooms) locally; CI deploys it and its D1 migrations on push to main

## Hard rules

- There are no accounts. Game state, blocked artists and settings are device-local (localStorage); the only server data is the optional group sync in D1 (song keys, timestamps, names and scores) and live buzz-in rooms, behind the Worker in `worker/`.
- A buzz-in room is ephemeral: it lives only in its Durable Object's storage and is wiped after idling; never copy room data (the song histories phones bring to their seats included) to D1.
- Only the host screen plays audio and knows the songs. A phone in a room must never receive a title before its reveal, or any stream URL; the room judges answers server-side. A phone's song history goes to the host only, never to another phone.
- Never store audio, stems or stream URLs server-side, and never put a group invite in a URL sent to a server, a log or an error message.
- The game must play end to end with no group and with the Worker unreachable.
- D1 schema changes are new files in `worker/migrations/`; never edit an applied migration.
- Song streaming URLs must be https and pass `sanitizeTrack`; never render or play unsanitized API data.
- Every playback path, sound effects included, must go through the audio engine in `src/lib/engine.js`; never create ad-hoc Audio elements or AudioContexts elsewhere.
- Gameplay numbers (clip ladder, points, bonus, hint cost, rounds, skips, cooldown days) live only in `src/lib/config.ts`; the numbers the buzz-in room enforces itself (skip vote share, skips per show) are Worker vars in `worker/wrangler.jsonc`.
- Verify changes E2E with the Playwright harness in `e2e/` before pushing (see docs/testing-and-deploy.md); pushes to main auto-deploy to production.

## Detailed docs (read on demand)

Read the matching doc before working in that area; skip otherwise.

- `docs/architecture.md` - module layout, design system, state model, screens, phases and scoring
- `docs/song-loading.md` - 3-tier song sourcing, filters, era/artist/cooldown rules, song category tags
- `docs/audio.md` - element playback modes, snips.json contract, playback session rules, autoplay priming, sound effects
- `docs/group-sync.md` - cross-phone groups: invite security, Worker API, D1 schema, retention, client outbox
- `docs/room-mode.md` - buzz-in rooms: host/phone/room split, protocol, secrecy, reconnects, limits, answer matching
- `docs/testing-and-deploy.md` - Playwright E2E harness, Pages and Worker deploy, catalog refresh CI
