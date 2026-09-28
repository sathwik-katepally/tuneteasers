# Architecture

## Module layout

- `index.html` - static shell; React 19 renders all UI into `#root`.
- `src/main.tsx` - entry point; loads the fonts (`@fontsource` Rozha One and Mukta), global styles, and renders `App` plus the debug overlay.
- `src/app.tsx` - the state owner for pass-the-phone and the home screen, and the router into the buzz-in room owners (`screen: "host" | "buzzer"`).
- `src/room/` - buzz-in rooms (docs/room-mode.md): `Host` (the host screen's state owner, with `Lobby` and `HostPlaying`) and `Phone` (a phone's join, buzzer and answer pad).
- `src/types.ts` - shared types for saved state, tracks, turns and verdicts.
- `src/lib/config.ts` - every gameplay number: clip ladder and its rung spans, points per rung, speed bonus, hint cost, round options, difficulty table, skips per contestant and the cooldown days; also the song category labels.
- `src/lib/save.ts` - the saved game: `loadSaved` (sanitize, migrate v6) and `save`.
- `src/lib/constants.js` - search queries, language/era tables, exclusion regex.
- `src/lib/utils.js` - pure helpers (`songKey`, `displayTitle`, `shuffle`, `safeUrl`, ...).
- `src/lib/storage.js` - track sanitization, the song history behind the cooldown (`tt_played`, `tt_tired`, `cooldownOf`, `heardCount`) and the blocked-artist store.
- `src/lib/group.ts` - optional group sync: the group invite, the write outbox, the group history fetch, the group's tickets and past results (docs/group-sync.md).
- `src/lib/me.ts` - optional personal ticket: the ticket and its outbox, preference sync, passkey registration and recovery, and the cooldown for the people present (docs/tickets.md).
- `src/lib/crate.js` - song loading (`buildCrate`) across the 3 source tiers, `withSameTierNext` (a skip's same-tier replacement), and `answerTitles` (the public title list a room phone autocompletes from).
- `src/lib/room.ts` - buzz-in room client: `createRoom`, the `#room=` link, `useRoom` (PartySocket), seat and host-show storage.
- `src/lib/answer.js` - answer folding, matching and autocomplete, shared with the Worker.
- `src/lib/engine.js` - the audio engine (songs and synthesised sound effects) and screen wake lock.
- `src/lib/ladder.ts` - `playRung`, which plays a clip ladder rung through the engine.
- `src/styles/tokens.css`, `src/styles/global.css` - design tokens (colors, fonts, hard shadows) and the few global classes (`.btn*`, `.display`, `.eyebrow`, `.grain`, `.link`, the debug overlay).
- `src/components/` - the cinema pieces, each with a CSS Module: `Theatre` (marquee, curtains, seat backs, game menu), `Bulbs` (bulb rows and frames), `Ticket`, `Curtain`, `Stamp`, `SplitFlap`, `Seg` (segmented radio), `CategoryPicker` (the setup screen's song-category stubs), `Equalizer`, `Reel`, `GroupPanel` (the home-screen group card), `TicketPanel` (the home-screen ticket card), `Qr`, `Stage` (the theatre plus the screen cross-fade, used by every state owner), and `DebugLog`.
- `src/screens/` - one component and CSS Module per screen: `Landing`, `Setup`, `Loading`, `Handover`, `Countdown`, `Playing`, `Reveal`, `Scoreboard`, `Podium`, `PastGames`.
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
`settings` is `{ mix, eras, difficulty, categories, mode, rounds }`; `categories` lists the chosen song categories (`[]` is "Any", which is also what saves from before categories load as, and unknown ids are dropped); `players` and `teams` are the setup rosters (`{ id, name, members, people? }`, members only used by teams, `people` the ticket ids playing as that entry).
`game` is `{ id, queue, trackIdx, turn, round, totalRounds, totalSongs, source, mode, difficulty, mix, cast, history, finished }` or null; `id` makes the finished show's group result idempotent.
`cast` is a snapshot of the roster with a `score` and the "Heard it too much" `skips` used, taken at game start, so editing the roster on the home screen never disturbs a saved game.
`history` holds one `{ id, song, points, round }` entry per judged turn; the box office derives each round's gains from it.
Every `state` change is saved to localStorage (`tuneteasers_v7`) by an effect; `loadSaved` restores and sanitizes it on boot.
A save from the pre-points version (`tuneteasers_v6`) is migrated once: players keep their names, scores are multiplied by `LEGACY_SCORE_SCALE`, "With vocals" becomes Easy and "Music only" Medium, and the old key is removed on the next save.
Unreadable or finished saved games are discarded instead of offered for resume.
A page load lands on the home screen; an unfinished game shows a Resume/Discard card there.
The one exception is a first visit, which opens the landing page instead (see Screens and phases).
The marquee menu offers "Home, keep the game" (resumable) and "End game" (in-app two-step confirm, clears the game).

Ephemeral per-turn state (`phase`, `turn`, the revealed track and `verdict`) is separate `useState` and intentionally not saved.
Judging a turn updates the saved game in one step (score, history, next turn and track), so a reload can never award the same turn twice; the reveal screen keeps showing the judged track and name from the ephemeral `verdict`.

## Screens and phases

`screen` is one of `landing | setup | game | done | past | host | buzzer`; `landing` is the poster that explains the game, `done` is the podium, `past` the group's Past shows list, and `host` / `buzzer` hand the whole page to `src/room/Host.tsx` or `src/room/Phone.tsx`.
`settings.play` (`pass | room`) picks the mode on the home screen; a `#room=` link opens `buzzer` directly.

The landing page shows on a first visit only: `isFirstVisit` in `src/lib/save.ts` is true when there is no save (v7 or v6) and `tt_landing_seen` is unset, and the landing sets that flag when it shows.
Returning visitors and anyone with a saved game land on setup, whose marquee has an About button back to the landing.
`#room=` and `#join=` links skip it.
A phone's "Back to the start" in `buzzer` returns to where it came from: the landing if it joined from there (or arrived by a room link on a first visit), otherwise setup.
The landing's clip ladder is Easy's, read from `src/lib/config.ts`.
Within `game`, `phase` runs `handover → countdown → cueing → playing ⇄ listened → reveal → (handover | board)`, with `blocked` when the browser refuses to start audio without a tap.
The screen wrapper is keyed per screen inside `AnimatePresence`, so every screen remounts and cross-fades.
Never change the key twice within one cross-fade (220 ms): `AnimatePresence mode="wait"` then stays on the old screen. The room host keys its countdown and song screens alike for this reason, since a buzz can land that fast.
After the last contestant of a round the box office (`board`) shows; after the final round (or when the crate runs out) it reads "Final count" and leads to the podium.
A skip keeps the same contestant and goes straight to a new countdown (see Skips below).

## Gameplay rules

All numbers are in `src/lib/config.ts`.
Difficulty: Easy plays popular songs with vocals ("full" sound, from a likely hook), Medium a broader pool as music only, Hard deeper cuts as music only; it is passed to `buildCrate` as its 4th argument.
Song categories (Dance & party, Romantic, Sad, Item songs, Mass beats) narrow the pool to corpus songs carrying any chosen tag; they are passed to `buildCrate` as its 7th argument (see docs/song-loading.md).
On the setup screen "Any" is the empty selection and clears the others; each category shows how many songs it offers for the chosen languages, eras and difficulty, and one with fewer than rounds x contestants is greyed out with "only N" (in Music-only with a note that few dance or item songs have a clean instrumental stretch).
A chosen category that turns thin stays tappable so it can be turned off.
Clip ladder: each turn starts with a 5s clip; "Hear 7s more" continues to 12s without replaying what was heard, and on Easy "Hear 8s more" goes on to 20s; Replay plays from the top to the current end (docs/audio.md).
Music-only (Medium and Hard) stops at 12s because it may only play inside a verified 12-second vocal-free window.
The ladders (`CLIP_LADDERS`, one per sound, and `ladderFor(plain)` with its `span`, `start` and `end`) are in `src/lib/config.ts` and the play call (`playRung`) in `src/lib/ladder.ts`, so any screen that runs a turn, the room host included, shares them.
Points: 100 / 60 / 30 by rung on Easy and 100 / 60 on Music-only, plus a speed bonus of up to 20 that stays full while a clip plays and fades over about 13s once it has ended, minus 20 if the film/year hint was taken, never below 10.
The player says the song or film aloud, then taps "I know this one" to score the current points or "I don't know this one" to score zero.
Either choice records the turn and reveals the answer immediately.
Teams: turns rotate through teams; if a team lists members, the phone holder rotates through them round by round.

## Skips

There are two ways to skip a song while listening, and both keep the same contestant.

- **"Heard it too much"** is for a song the player has heard to death.
  Each contestant (player or team) gets `SKIPS_PER_PLAYER` (1) per show, shown as a ticket stub next to the link ("1 left", then "Used"), and it is offered until the player judges.
  The replacement is the next queued song from the same corpus tier (`withSameTierNext`), so skipping a hard song cannot fish for an easy one; when no song of that tier is left the link is not offered.
  The skipped title goes up on the next countdown ("Skipped: Kesariya") so the room sees what was skipped.
  The song is recorded as `tired` on the device and the group, which keeps it out of crates for longer than a played song (docs/song-loading.md).
- **"Skip this song"** shows only after a stream error, instead of the link above.
  It is free and unlimited, takes the next song in the queue, and records nothing: a song that only failed to stream may play fine next time.

Buzz-in rooms have their own vote-based version (docs/room-mode.md).
