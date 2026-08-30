# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while a fetch/decode is in flight.
`playMuffled` returns `"played" | "failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).

## Muffle path (default "Music only" mode)

`playMuffled` fetches the stream, decodes it via Web Audio (`decodeAudioData`), trims to 45s, and caches one decoded buffer.
The graph muffles vocals rather than removing them: an L−R channel-difference branch (vocals are usually center-panned and cancel), peaking cuts at 1.2kHz/3kHz, a 6.5kHz lowpass, plus a 140Hz lowpass branch to keep the bass foundation.
This path requires CORS-readable audio (`fetch` + decode), which is why song sources must serve `Access-Control-Allow-Origin: *`.
If decode fails, the caller falls back to `playElement` (plain `<audio>`, vocals intact) and shows a notice.

## Reveal playback

`revealTrack` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration−60)`), for 30s `hook` clips it starts at 0.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).
