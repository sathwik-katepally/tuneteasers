# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output, songs and sound effects alike.
The client does no audio analysis or processing of its own beyond a realtime filter graph.
Per-song facts (where the song is instrumental) are computed once, offline, by `scripts/build-snips.mjs` and shipped as `public/snips.json`; the client just seeks an `<audio>` element and plays.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while an element is still buffering.
`playSnippet(track, offset, secs, cb)` returns the mode that played (`"snip" | "muffle" | "plain"`) or `"failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).
`playElement(url, offset, secs, cb)` is the as-is path.
Both take callbacks `cb = { onStart, onEnd, onErr, onBlocked }` (`playSnippet` uses `onEnd` and `onBlocked`); stale sessions never fire them.

## The snips.json contract

`public/snips.json` is built offline in CI (see docs/testing-and-deploy.md) and fetched same-origin, no-cache, once per crate build:

    { "v": 1, "built": "...", "snips": { "<key>": [startSec, winMax], ... } }

`<key>` is the canonical song title key, `songKey(title)` from `src/lib/utils.js`, the same normalization the crate uses for dedupe.
`startSec` is the start of the song's most instrumental window (integer seconds); the window is ~10-12s of verified coverage.
`winMax` is the window's max p(voice) from the offline MusiCNN VAD; lower is cleaner.
The file keeps entries up to winMax 0.40, but the client only trusts entries below `SNIP_CLEAN_MAX` (`src/lib/constants.js`, currently 0.25), so the threshold can be tuned without a corpus rebuild.
A missing or unfetchable snips.json is normal and handled: no track gets a verified window and everything plays through the muffle fallback.

## Playback modes (default "Music only" mode)

- `"snip"`: the track has a verified instrumental window (`track.snip`, annotated by the crate).
  The element is seeked to `track.snip + offset` and played raw; no Web Audio processing at all.
- `"muffle"`: no verified window (unindexed Saavn track, or the 30s hook-clip fallback tiers).
  The element is routed through a realtime biquad muffle graph via `MediaElementAudioSourceNode`: a 140Hz bass foundation branch plus peaking cuts at 1.2kHz and 3kHz into a 6.5kHz lowpass.
  This requires `crossOrigin="anonymous"`; both the Saavn mirrors and iTunes previews serve CORS-readable audio (verified 2026-08-31).
  If wiring the element into Web Audio fails, playback falls through to `"plain"`.
- `"plain"`: as-is element playback with the "you'll hear it as it is" notice; also the mode for reveals and for Easy (the With-vocals difficulty), where clips start at a likely hook (`hookOffset` in `src/lib/config.ts`) instead of the intro.

`window.__ttLastMode` reports the mode that actually played (E2E/debug surface).
Every rung of the clip ladder (3, 5, 8, 12s) plays from the start of the clip window (the snip start, or the hook offset on Easy); the 12s rung may run past the ~10-12s verified window, which the owner has explicitly accepted.

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
An element that was previously muffled is rewired straight to the speakers for the reveal.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).

## Diagnostics

`src/lib/log.js` keeps a structured ring buffer (250 entries) mirrored to the console and persisted in localStorage: boot, crate tier results (including `snips: "ok"|"none"` and the `snipped` count), every play with its mode, and every fallback (`element-fail`, `muffle-wire-fail`, `muffle-fallback`, `element-play`, `play-blocked`, `sfx-fail`), plus `snippet` (rung and clip length), `skip` and `go-home` from the game.
A `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off).
`window.__ttLog.dump()` reads the log programmatically.
The old on-device pipeline's localStorage keys (`tt_vad`, `tt_ml_slow`) are obsolete; the code no longer reads them and stale values are simply ignored.

## The bulb equalizer

The level meter under the cinema screen is decorative CSS, not an analyser: reading real levels would mean routing the raw "snip" element through Web Audio, which the engine deliberately avoids.
