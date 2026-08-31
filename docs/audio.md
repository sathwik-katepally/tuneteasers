# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output.
The client does no audio analysis or processing of its own beyond a realtime filter graph.
Per-song facts (where the song is instrumental) are computed once, offline, by `scripts/build-snips.mjs` and shipped as `public/snips.json`; the client just seeks an `<audio>` element and plays.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while an element is still buffering.
`playSnippet` returns the mode that played (`"snip" | "muffle" | "plain"`) or `"failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).

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
- `"plain"`: as-is element playback with the "playing it as-is" notice; also the mode for reveals and the With-vocals setting.

`window.__ttLastMode` reports the mode that actually played (E2E/debug surface).
Snippet offsets (replay, extend) are relative to the snip start; replays reuse the window, while extends and the 15s snippet setting may run past the ~10-12s verified window, which the owner has explicitly accepted.

## Buffering and the stall guard

A play call waits only for the element's metadata (so the seek can land); a dead or stalled stream trips a 12s guard and the call reports `"failed"`, and the app shows a fallback notice instead of pinning the game on "Cueing it up...".
The engine keeps one light prefetch: a `preload="auto"` Audio element for the next track, at most one, adopted by the next play call when the URL matches.

## Reveal playback

`revealTrack` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration-60)`), for 30s `hook` clips it starts at 0.
An element that was previously muffled is rewired straight to the speakers for the reveal.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).

## Diagnostics

`src/lib/log.js` keeps a structured ring buffer (250 entries) mirrored to the console and persisted in localStorage: boot, crate tier results (including `snips: "ok"|"none"` and the `snipped` count), every play with its mode, and every fallback (`element-fail`, `muffle-wire-fail`, `muffle-fallback`, `element-play`).
A `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off).
`window.__ttLog.dump()` reads the log programmatically.
The old on-device pipeline's localStorage keys (`tt_vad`, `tt_ml_slow`) are obsolete; the code no longer reads them and stale values are simply ignored.
