# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output, songs and sound effects alike.
The client does no vocal analysis.
The offline scorer in `scripts/build-snips.mjs` produces source-specific intervals in `public/snips.json`.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while an element is still buffering.
`playSnippet(track, offset, secs, cb)` returns `"snip"`, `"failed"`, or `"superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).
`playElement(url, offset, secs, cb)` is the as-is path.
Both take callbacks `cb = { onStart, onEnd, onErr, onBlocked }`; stale sessions never fire them.
For a clip (`secs > 0`), `onStart` fires on the element's first `playing` event, when audio is actually flowing, so the UI never runs ahead of the sound.
The game does not call these directly: `playRung(track, plain, rung, replay, cb)` in `src/lib/ladder.ts` turns a ladder rung into the right call (see "The clip ladder" below).

## The snips.json contract

`public/snips.json` is built offline in CI (see docs/testing-and-deploy.md) and fetched same-origin, no-cache, once per crate build:

    { "v": 3, "built": "...", "snips": { "<Saavn ID>": { "sourceId": "<Saavn ID>", "startSec": 78, "endSec": 98, "maxVoice": 0.023, "method": "continuous-v3" } }, "checked": { "<rejected Saavn ID>": "continuous-v3/0.25" }, "corpusIds": [...] }

The key and `sourceId` must both match the returned Saavn recording ID.
`checked` records scored recordings that did not pass and never authorizes playback.
The schema version, method name, window length (`SNIP_WINDOW_SEC`, 20 seconds) and threshold (`SNIP_CLEAN_MAX`) are shared constants in `src/lib/constants.js`, read by the scorer, the crate and the engine alike.
The window must hold the whole clip ladder; `src/lib/config.ts` throws at load if the ladder outgrows it.
The scorer fetches that recording, then accepts a whole-second 20-second interval only if every overlapping ~3-second patch, spaced about one second apart and covering the full interval, has voice probability below `SNIP_CLEAN_MAX`.
It uses the maximum raw patch score, without smoothing away a high-scoring patch.
To find candidates it scores every other patch across the song, then densely scans (every ~1 second) up to four regions around the quietest stretches and verifies whole-second starts inside any run of clean patches long enough for a window.
An index with another schema (including the old v2 10-second index), an unmatched ID, an interval that is not exactly 20 seconds, an absent entry, or a build timestamp over 30 days old cannot authorize Music-only playback.
A saved game from the 10-second release drops its old intervals when it loads; resuming a Music-only game rebinds its queue to the current index, or shows the shortage message.
The client also checks the stream duration covers the interval.
When the index is missing or too few safe tracks remain, the player sees a shortage message.

## The clip ladder

A turn listens to one continuous 20-second clip window in three rungs: the first 5 seconds, then "Hear 7s more" continues from 5 to 12 seconds, then "Hear 8s more" from 12 to 20.
Replay plays everything heard so far, from 0 to the current rung's end.
The numbers are `CLIP_SEGMENTS` in `src/lib/config.ts`; `rungSpan(rung, replay)` gives the `{ from, to }` seconds a play covers.
A continuation always seeks, even to where the element already is: Chromium otherwise resumes a paused element about 60ms past its pause point, which would skip audio at the seam.
The engine stops a clip at a media time, not after a wall-clock delay: a timer re-aims at the end from the element's own clock (and, for Music-only, re-aims the gain gate on the audio clock), so each rung is exact to a few milliseconds and the next one starts where it stopped.
`currentTime` only moves in steps (100-250ms apart, and a busy WebKit reports a stale value for longer), so between steps the engine extrapolates from when it last saw the value change and polls every 15ms near the end.
`e2e/ladder.mjs` measures this on the media clock.

## Playback modes

- `"snip"`: Medium and Hard play only inside the verified 20-second interval.
  The engine seeks before unmuting, routes the CORS element through an AudioContext gain gate, and closes the gate at the clip's end on the audio clock.
  The media-time timer also pauses the element there.
  Failure to seek, wire the gate, or find a valid interval returns `"failed"` without starting raw playback.
  The engine rejects any interval that is not exactly `SNIP_WINDOW_SEC` long and any offset and length outside it.
- `"plain"`: Easy keeps the full vocals; its window starts at a likely hook (`hookOffset` in `src/lib/config.ts`); reveals also play as-is.

`window.__ttLastMode` reports the mode that actually played, and `window.__ttClips` records each clip's media start and stop (E2E/debug surfaces).

## What verification can and cannot say

MusiCNN is a voice detector, not proof that a clip has no vocals.
Quiet singing, speech under loud instruments, unusual vocal timbres, and model mistakes can pass its threshold.
The overlapping patches close the old uncovered gaps, but even continuous model coverage cannot guarantee zero audible vocals.
The `sourceId`, exact start/end, method, and maximum raw voice probability in the index make each decision auditable against the live Saavn recording.
For a listening audit, resolve an indexed `sourceId` from the song endpoint, play the exact `[startSec,endSec]` interval from its HTTPS `downloadUrl`, and record any audible vocals before adjusting the index or threshold.

## Buffering and the stall guard

A play call waits only for the element's metadata (so the seek can land); a dead or stalled stream trips a 12s guard and the call reports `"failed"`, and the app shows a fallback notice instead of pinning the game on "Cueing it up...".
The engine keeps one light prefetch: a `preload="auto"` Audio element for the next track, at most one, adopted by the next play call when the URL matches.
`prefetch(track, plain)` takes the same `plain` flag as `prime`, so an Easy track is not fetched as a CORS element that playback would then have to refetch.

## Starting audio from the countdown (autoplay)

The first clip of a turn starts from a timer, not from a tap.
The countdown hands over silently: when "Roll it" ends the listening screen fades in, and only once its fade has finished (the wrapper's `onAnimationComplete` in `src/app.tsx`, with a 1.5s fallback for a hidden tab that never finishes animating) does the clip start.
The sound, "Now playing" and the clip bar then start together on the element's `playing` event; before this, audio started ~0.3s before the screen was visible.
iOS Safari only lets an element start audio outside a tap once that element has been played inside one, so the hand-over tap calls `engine.prime(track, plain)`: it resumes the AudioContext and plays the upcoming track's element muted for a moment, then pauses it (session-checked so it can never pause real playback).
The unlock belongs to the element, so the later, timer-started play is still covered.
If a browser still refuses (`play()` rejects with `NotAllowedError`), the engine logs `play-blocked`, stops the session and calls `onBlocked`; the game shows a "Tap to play" button that replays the rung inside a tap.
`e2e/autoplay.mjs` emulates the iOS rule in Chromium and checks both paths.

## Sound effects

`engine.sfx(name)` synthesises short effects on the engine's AudioContext; there are no audio files.
Names: `tick` (a bulb clicking on, per countdown number), `roll` (countdown "Roll it"), `stamp` (the HOUSEFULL stamp), `projector` (the projector sputter on a miss), `flaps` (the box-office board settling), `fanfare` (the podium), and on a room's host screen `buzz` (a game-show buzzer when someone buzzes in) and `nope` (a wrong answer).
In a buzz-in room only the host screen makes any sound; phones are silent.
It never creates or resumes the context itself, because it is also called from timers; a tap has to have called `ac()` first (every play and the hand-over prime do), otherwise the call is a silent no-op.
Effects share one cached 0.5s noise buffer; each call builds a few short-lived oscillator and filter nodes that stop themselves.

## Reveal playback

`showAnswer` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration-60)`), for 30s `hook` clips it starts at 0.
An element that was routed through the Music-only gain gate is rewired straight to the speakers for the reveal.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).

## Diagnostics

`src/lib/log.js` keeps a structured ring buffer (250 entries) mirrored to the console and persisted in localStorage: boot, crate tier results (including `snips: "ok"|"none"` and the `snipped` count), every play with its mode, and failures (`element-fail`, `snip-fail`, `element-play`, `play-blocked`, `sfx-fail`), plus `snippet` (rung and clip length), `skip` and `go-home` from the game, and `room-song` (each change of a room song's state on the host) and `room-create-fail`.
A `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off).
`window.__ttLog.dump()` reads the log programmatically.
The old on-device pipeline's localStorage keys (`tt_vad`, `tt_ml_slow`) are obsolete; the code no longer reads them and stale values are simply ignored.

## The bulb equalizer

The level meter under the cinema screen is decorative CSS, not an analyser.
