# Architecture

## Module layout

- `index.html` - static shell; React 19 renders all UI into `#root`.
- `src/main.tsx` - entry point; renders `App` and imports global styles.
- `src/app.tsx` - the single state owner; all game state, actions, and screen routing live here.
- `src/screens/Setup.tsx` - settings, players, blocked-artist management, plus the `Loading` screen.
- `src/screens/Game.tsx` - the round loop UI (play, guess, hint, reveal, score, block artist).
- `src/screens/Done.tsx` - final leaderboard.
- `src/components/bits.tsx` - tiny shared presentational pieces (`Chip`, `Disc`, `ScoreRow`).
- `src/types.ts` - shared types for saved state, tracks, and screen props.
- `tsconfig.json` - strict UI type checking; existing `src/lib/*.js` remains JavaScript with `allowJs` and `checkJs` off.
- `src/lib/constants.js` - search queries, language/era tables, exclusion regex.
- `src/lib/utils.js` - pure helpers (`songKey`, `shuffle`, `safeUrl`, `fmtScore`, ...).
- `src/lib/storage.js` - localStorage persistence, track sanitization, played-cooldown and blocked-artist stores.
- `src/lib/crate.js` - song loading (`buildCrate`) across the 3 source tiers.
- `src/lib/engine.js` - the audio engine and screen wake lock.
- `src/styles.css` - all styling; plain CSS with custom properties, no framework.

## State model

`App` holds one persisted `state` object: `{ screen, settings, players, game }`.
`settings` is `{ mix, sound, snippetLen, eras }`.
`game` is `{ queue, trackIdx, turn, round, totalSongs, source }` or null when no game is running.
Every `state` change is persisted to localStorage (`tuneteasers_v6`) by an effect, and `loadPersisted` restores and sanitizes it on boot.
A page load always lands on the setup (home) screen; if a saved game exists, setup shows a Resume/Discard card rather than jumping straight into it.
The game screen's "← Home" button navigates back without destroying the game (it resets the transient phase to `ready`); the footnote's "End game" link is the destructive exit.
Ephemeral per-round UI state (phase, snippet progress, hint, scoreboard visibility) is separate `useState` and intentionally not persisted.

## Screens and phases

`screen` is one of `setup | game | done`; each screen root element carries a matching `key` so React remounts cleanly on switches (do not remove these keys - reusing DOM across screens previously caused duplicate disc / missing topbar bugs).
Within the game screen, `phase` cycles `ready → cueing → playing → guessing → revealed → (next round) ready`.
Scoring: +1 per correct guess, halved to +½ if the movie/year hint was used that round; scores are stored as floats in 0.5 steps and rendered via `fmtScore` (e.g. `3½`).
