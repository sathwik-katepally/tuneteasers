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

    { "v": 5, "built": "...", "snips": { "<Saavn ID>": { "sourceId": "<Saavn ID>", "startSec": 78, "endSec": 90, "vocalDb": -63.5, "limitDb": -50, "method": "vocal-stem-v5" } }, "checked": { "<rejected Saavn ID>": "vocal-stem-v5/-50" }, "corpusIds": [...] }

The key and `sourceId` must both match the returned Saavn recording ID.
`checked` records scored recordings that did not pass and never authorizes playback.
The window length (`SNIP_WINDOW_SEC`, 12 seconds) and the accepted schema versions (`SNIP_ACCEPTED`) are shared constants in `src/lib/constants.js`, read by the scorer, the crate and the engine alike.
Two versions authorize playback, each with its own method and check: v4 (`continuous-v4`, MusiCNN, `maxVoice` below 0.25) and v5 (`vocal-stem-v5`, separated vocal stems, `vocalDb` below `SNIP_VOCAL_MAX_DB`, -50 dBFS).
The index that ships is v5; v4 is the index the scorer carried over while it built the vocal-stem curves for the corpus, and it no longer writes one (see "How windows are judged" below).
An index of any other version, an entry whose method is not its version's, an unmatched ID, an interval that is not exactly 12 seconds, an absent entry, or a build timestamp over 30 days old cannot authorize Music-only playback.
The window must hold the whole Music-only clip ladder; `src/lib/config.ts` throws at load if that ladder outgrows it.
A queued track keeps its window's method; a saved snip without an accepted method (every save before v5, and the 10- and 20-second releases) is dropped when it loads, and resuming a Music-only game rebinds its queue to the current index, or shows the shortage message.
The client also checks the stream duration covers the interval.
When the index is missing or too few safe tracks remain, the player sees a shortage message.

## How windows are judged

MusiCNN, the v4 detector, labels whole tracks as vocal or instrumental; it never saw Indian film music, lets vocal tails into windows and reads flute, strings and shehnai as voice.
v5 separates the vocal stem instead and measures how loud it is.
`scripts/vocal-curve.py` decodes each song once, separates its vocal stem with htdemucs, and measures the stem and the mix every 0.1s; Whisper (large-v3-turbo) then transcribes the stem.
The scorer keeps three curves per song in `scripts/voice-curves.json`, one byte per 0.5s patch: the stem level (the loudest 0.1s in the patch), the mix level, and the highest probability of any word Whisper heard over the patch.
The best candidate windows are then separated again with Mel-Band RoFormer, a second separator of a different design, over the window and its margins only, and Whisper transcribes that stem too; up to three candidates per song, cleanest first.
A whole-second 12-second window passes only if:

- both vocal stems stay below the song's limit from 2 seconds before the window to its end (the lead-in stops a vocal tail from leaking into the first seconds);
- the limit is -50 dBFS, or 38 dB below the song's own singing level if that is lower, where the singing level is the median htdemucs stem level over patches holding a word Whisper is sure of (probability 0.8 or more);
- neither Whisper heard a word (probability 0.5 or more) within a second of that span, counting only words over a stem louder than -60 dBFS.

The scorer picks the passing window with the quietest stems.
The numbers were calibrated without listening, from the songs' own sung regions: across 262 songs, 99.7% of the stretches Whisper was sure were sung peaked above -51 dBFS and within 38 dB of their song's singing level, so both limits sit below nearly all recognisable singing.
The word floor is there because over a silent stem Whisper invents words (mostly "झाल"); a voice one separator missed is the other separator's to catch.
Every merge prints the same calibration for the whole corpus (the share of sure-sung stretches the limits would let through).
Curves are self-describing (hop, patch length, and either `lo`/`step` in dBFS or a probability `scale`), rounded up so a stored level is never quieter than measured, and kept per Saavn ID and per detector name; MusiCNN's `musicnn-voice-dense-v1` curves stay beside them.
The RoFormer curves are partial: patches it never measured hold 255 (+27.5 dBFS), so they can never pass.
A later change of window length is judged from the stored curves, but any window outside what RoFormer measured then fails until that song is scored again.

## The clip ladder

A turn listens to one continuous clip window in rungs: the first 5 seconds, then "Hear 7s more" continues from 5 to 12 seconds, and on Easy "Hear 8s more" from 12 to 20.
Music-only has only the first two rungs, because its window is a verified 12-second interval; Easy plays from the song's hook with the vocals in and needs no verified window.
Replay plays everything heard so far, from 0 to the current rung's end.
The numbers are `CLIP_LADDERS` in `src/lib/config.ts`, one ladder per sound; `ladderFor(plain).span(rung, replay)` gives the `{ from, to }` seconds a play covers.
To give Music-only its third rung back, add it to the `inst` ladder once the index holds enough 20-second windows: raise `SNIP_WINDOW_SEC`, bump `SNIP_INDEX_V` and `SNIP_METHOD`, and dispatch a full rescore (docs/testing-and-deploy.md); config.ts refuses to load a ladder longer than the window.
A continuation always seeks, even to where the element already is: Chromium otherwise resumes a paused element about 60ms past its pause point, which would skip audio at the seam.
The engine stops a clip at a media time, not after a wall-clock delay: a timer re-aims at the end from the element's own clock (and, for Music-only, re-aims the gain gate on the audio clock), so each rung is exact to a few milliseconds and the next one starts where it stopped.
`currentTime` only moves in steps (100-250ms apart, and a busy WebKit reports a stale value for longer), so between steps the engine extrapolates from when it last saw the value change and polls every 15ms near the end.
`e2e/ladder.mjs` measures this on the media clock.

## Playback modes

- `"snip"`: Medium and Hard play only inside the verified 12-second interval.
  The engine seeks before unmuting, routes the CORS element through an AudioContext gain gate, and closes the gate at the clip's end on the audio clock.
  The media-time timer also pauses the element there.
  Failure to seek, wire the gate, or find a valid interval returns `"failed"` without starting raw playback.
  The engine rejects any interval that is not exactly `SNIP_WINDOW_SEC` long and any offset and length outside it.
- `"plain"`: Easy keeps the full vocals; its window starts at a likely hook (`hookOffset` in `src/lib/config.ts`); reveals also play as-is.

`window.__ttLastMode` reports the mode that actually played, and `window.__ttClips` records each clip's media start and stop (E2E/debug surfaces).

## What verification can and cannot say

Two separators and a speech recogniser agreeing that a window is quiet is strong evidence, not proof.
Separators can leave a soft voice in the accompaniment, both can miss the same unusual timbre (a heavily processed chorus, a wordless hum), and Whisper cannot hear lyrics a separator removed.
The design leans on rejection: a window needs both stems below the limit, and any doubt (a missed RoFormer check, an unmeasured patch, a word over an audible stem) rejects it.
Each entry's `sourceId`, exact start and end, `vocalDb` (the loudest patch of either stem over the lead-in and window) and `limitDb` make every decision auditable against the stored curves and the live recording.
To audit automatically, separate `[startSec - 3, endSec + 1]` of the HTTPS `downloadUrl` again (htdemucs, RoFormer, or another separator), measure the stem and run a lyric or singing tagger on it; there is no manual review step.

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
The prime marks the element paused, so the first clip always seeks to its start: WebKit keeps the media clock running behind a pause that quick, and an element that reads 0s would otherwise resume from however long ago the tap was (a window starting at 0s lost its first 4 seconds).
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

`src/lib/log.js` keeps a structured ring buffer (250 entries) mirrored to the console and persisted in localStorage: boot, crate tier results (including `snips: "ok"|"none"` and the `snipped` count), every play with its mode, and failures (`element-fail`, `snip-fail`, `element-play`, `play-blocked`, `sfx-fail`), plus `snippet` (rung and clip length), `skip` and `go-home` from the game, and `room-song` (each change of a room song's state on the host), `room-create-fail` and `room-refused` (a host command the room refused, with its code and the host's phase).
A `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off).
`window.__ttLog.dump()` reads the log programmatically.
The old on-device pipeline's localStorage keys (`tt_vad`, `tt_ml_slow`) are obsolete; the code no longer reads them and stale values are simply ignored.

## The bulb equalizer

The level meter under the cinema screen is decorative CSS, not an analyser.
