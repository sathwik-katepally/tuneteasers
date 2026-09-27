# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output, songs and sound effects alike.
The client does no vocal analysis.
The offline scorer in `scripts/build-snips.mjs` produces source-specific intervals in `public/snips.json`.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while an element is still buffering.
`playSnippet(track, offset, secs, cb)` returns `"snip"`, `"failed"`, or `"superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).
`playElement(url, offset, secs, cb)` is the as-is path.
Both take callbacks `cb = { onStart, onEnd, onErr, onBlocked }` (`playSnippet` uses `onEnd` and `onBlocked`); stale sessions never fire them.

## The snips.json contract

`public/snips.json` is built offline in CI (see docs/testing-and-deploy.md) and fetched same-origin, no-cache, once per crate build:

    { "v": 2, "built": "...", "snips": { "<Saavn ID>": { "sourceId": "<Saavn ID>", "startSec": 78, "endSec": 88, "maxVoice": 0.023, "method": "continuous-v2" } }, "checked": { "<rejected Saavn ID>": "continuous-v2/0.25" } }

The key and `sourceId` must both match the returned Saavn recording ID.
`checked` records scored recordings that did not pass and never authorizes playback.
The scorer fetches that recording, then accepts a 10-second interval only if every overlapping ~3-second patch, spaced about one second apart and covering the full interval, has voice probability below `SNIP_CLEAN_MAX` in `src/lib/constants.js`.
It uses the maximum raw patch score, without smoothing away a high-scoring patch.
An index with another schema, an unmatched ID, a malformed interval, an absent entry, or a build timestamp over 30 days old cannot authorize Music-only playback.
The client also checks the stream duration covers the interval.
When the index is missing or too few safe tracks remain, the player sees a shortage message.

## Playback modes

- `"snip"`: Medium and Hard use the verified interval for all four rungs (3, 5, 8, 10 seconds).
  The engine seeks before unmuting, routes the CORS element through an AudioContext gain gate, and schedules silence at the interval end on the audio clock.
  A media-time boundary and pause timer also stop the element.
  Failure to seek, wire the gate, or find a valid interval returns `"failed"` without starting raw playback.
- `"plain"`: Easy keeps the full vocals and its 3, 5, 8, 12-second ladder, starting at a likely hook (`hookOffset` in `src/lib/config.ts`); reveals also play as-is.

`window.__ttLastMode` reports the mode that actually played (E2E/debug surface).
Every rung and replay starts at the same interval start.
The engine rejects any offset and length outside that interval.

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

The first clip of a turn starts from a timer at the end of the 3-2-1 countdown, not from a tap.
iOS Safari only lets an element start audio outside a tap once that element has been played inside one, so the hand-over tap calls `engine.prime(track, plain)`: it resumes the AudioContext and plays the upcoming track's element muted for a moment, then pauses it (session-checked so it can never pause real playback).
If a browser still refuses (`play()` rejects with `NotAllowedError`), the engine logs `play-blocked`, stops the session and calls `onBlocked`; the game shows a "Tap to play" button that replays the rung inside a tap.
`e2e/autoplay.mjs` emulates the iOS rule in Chromium and checks both paths.

## Sound effects

`engine.sfx(name)` synthesises short effects on the engine's AudioContext; there are no audio files.
Names: `tick` (a bulb clicking on, per countdown number), `roll` (countdown "Roll it"), `stamp` (the HOUSEFULL stamp), `projector` (the projector sputter on a miss), `flaps` (the box-office board settling) and `fanfare` (the podium).
It never creates or resumes the context itself, because it is also called from timers; a tap has to have called `ac()` first (every play and the hand-over prime do), otherwise the call is a silent no-op.
Effects share one cached 0.5s noise buffer; each call builds a few short-lived oscillator and filter nodes that stop themselves.

## Reveal playback

`showAnswer` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration-60)`), for 30s `hook` clips it starts at 0.
An element that was routed through the Music-only gain gate is rewired straight to the speakers for the reveal.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).

## Diagnostics

`src/lib/log.js` keeps a structured ring buffer (250 entries) mirrored to the console and persisted in localStorage: boot, crate tier results (including `snips: "ok"|"none"` and the `snipped` count), every play with its mode, and failures (`element-fail`, `snip-fail`, `element-play`, `play-blocked`, `sfx-fail`), plus `snippet` (rung and clip length), `skip` and `go-home` from the game.
A `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off).
`window.__ttLog.dump()` reads the log programmatically.
The old on-device pipeline's localStorage keys (`tt_vad`, `tt_ml_slow`) are obsolete; the code no longer reads them and stale values are simply ignored.

## The bulb equalizer

The level meter under the cinema screen is decorative CSS, not an analyser.
