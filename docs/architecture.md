# Architecture

## Module layout

- `index.html` - static shell; React 19 renders all UI into `#root`.
- `src/main.tsx` - entry point; loads the fonts (`@fontsource` Rozha One and Mukta), global styles, and renders `App` plus the debug overlay.
- `src/app.tsx` - the single state owner; all game state, actions, and screen routing live here.
- `src/types.ts` - shared types for saved state, tracks, turns and verdicts.
- `src/lib/config.ts` - every gameplay number: clip ladder, points per rung, speed bonus, hint cost, round options, difficulty table.
- `src/lib/save.ts` - the saved game: `loadSaved` (sanitize, migrate v6) and `save`.
- `src/lib/constants.js` - search queries, language/era tables, exclusion regex.
- `src/lib/utils.js` - pure helpers (`songKey`, `displayTitle`, `shuffle`, `safeUrl`, ...).
- `src/lib/storage.js` - track sanitization, the played-cooldown store and the blocked-artist store.
- `src/lib/crate.js` - song loading (`buildCrate`) across the 3 source tiers.
- `src/lib/engine.js` - the audio engine (songs and synthesised sound effects) and screen wake lock.
- `src/styles/tokens.css`, `src/styles/global.css` - design tokens (colors, fonts, hard shadows) and the few global classes (`.btn*`, `.display`, `.eyebrow`, `.grain`, `.link`, the debug overlay).
- `src/components/` - the cinema pieces, each with a CSS Module: `Theatre` (marquee, curtains, seat backs, game menu), `Bulbs` (bulb rows and frames), `Ticket`, `Curtain`, `Stamp`, `SplitFlap`, `Seg` (segmented radio), `Equalizer`, `Reel`, and `DebugLog`.
- `src/screens/` - one component and CSS Module per screen: `Setup`, `Loading`, `Handover`, `Countdown`, `Playing`, `Reveal`, `Scoreboard`, `Podium`.
- `tsconfig.json` - strict UI type checking; `src/lib/*.js` stays JavaScript with `allowJs` and `checkJs` off.

## Look and motion

The design is "Single Screen Talkies": an old Indian single-screen cinema.
Colors and fonts are tokens in `src/styles/tokens.css` (maroon, cream, vermilion, bulb yellow, teal; Rozha One for display, Mukta for text); corners are sharp and shadows are hard offsets.
Styling is CSS Modules per component; there is no CSS framework.
Animation uses Motion through `LazyMotion` with the `domAnimation` feature set and `m` components (`strict`, so a full `motion` component import fails loudly).
Anything that loops (bulbs, equalizer, confetti, spotlights, reel) is plain CSS keyframes, and layout moves (the box-office reorder) are a small FLIP with the Web Animations API, so the heavier `domMax` features are not needed.
`MotionConfig reducedMotion="user"` plus a global `prefers-reduced-motion` rule turn the motion off; screens that time things (countdown, curtain, board settle) shorten their timers too.
On desktop (900px and up) the phone-width stage sits between curtains under the marquee; below that it is a single column.
A `max-height: 760px` pass tightens spacing so every in-game screen fits a short phone without scrolling (the E2E harness checks this).

## State model

`App` holds one persisted `state` object: `{ screen, settings, players, teams, game }`.
`settings` is `{ mix, eras, difficulty, mode, rounds }`; `players` and `teams` are the setup rosters (`{ id, name, members }`, members only used by teams).
`game` is `{ queue, trackIdx, turn, round, totalRounds, totalSongs, source, mode, difficulty, cast, history, finished }` or null.
`cast` is a snapshot of the roster with a `score` each, taken at game start, so editing the roster on the home screen never disturbs a saved game.
`history` holds one `{ id, song, points, round }` entry per judged turn; the box office derives each round's gains from it.
Every `state` change is saved to localStorage (`tuneteasers_v7`) by an effect; `loadSaved` restores and sanitizes it on boot.
A save from the pre-points version (`tuneteasers_v6`) is migrated once: players keep their names, scores are multiplied by `LEGACY_SCORE_SCALE`, "With vocals" becomes Easy and "Music only" Medium, and the old key is removed on the next save.
Unreadable or finished saved games are discarded instead of offered for resume.
A page load always lands on the home screen; an unfinished game shows a Resume/Discard card there.
The marquee menu offers "Home, keep the game" (resumable) and "End game" (in-app two-step confirm, clears the game).

Ephemeral per-turn state (`phase`, `turn`, the revealed track and `verdict`) is separate `useState` and intentionally not saved.
Judging a turn updates the saved game in one step (score, history, next turn and track), so a reload can never award the same turn twice; the reveal screen keeps showing the judged track and name from the ephemeral `verdict`.

## Screens and phases

`screen` is one of `setup | game | done`; `done` is the podium.
Within `game`, `phase` runs `handover → countdown → cueing → playing ⇄ listened → reveal → (handover | board)`, with `blocked` when the browser refuses to start audio without a tap.
The screen wrapper is keyed per screen inside `AnimatePresence`, so every screen remounts and cross-fades.
After the last contestant of a round the box office (`board`) shows; after the final round (or when the crate runs out) it reads "Final count" and leads to the podium.
Skip keeps the same contestant and goes straight to a new countdown.

## Gameplay rules

All numbers are in `src/lib/config.ts`.
Difficulty: Easy plays popular songs with vocals ("full" sound, from a likely hook), Medium a broader pool as music only, Hard deeper cuts as music only; it is passed to `buildCrate` as its 4th argument.
Clip ladder: each turn starts with a 3s clip, and "Hear more" steps to 5, 8 and 12s; each rung replays from the start of the clip window.
Points: 100 / 70 / 50 / 30 by rung, plus a speed bonus of up to 20 that stays full while a clip plays and fades over about 13s once it has ended, minus 20 if the film/year hint was taken, never below 10.
The player says the song or film aloud, then taps "I know this one" to score the current points or "I don't know this one" to score zero.
Either choice records the turn and reveals the answer immediately.
Teams: turns rotate through teams; if a team lists members, the phone holder rotates through them round by round.
