# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while a fetch/decode is in flight.
`playMuffled` returns `"played" | "failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).

## Vocal reduction path (default "Music only" mode)

`playMuffled` fetches the stream, decodes it via Web Audio (`decodeAudioData`), trims to 45s, then runs `centerCut` from `src/lib/centercut.js` offline on the buffer.
`centerCut` is per-bin center-channel suppression: an STFT (fft.js, 2048-point, 50% overlap, sqrt-Hann analysis+synthesis windows), where bins with near-identical L/R content (center-panned = almost always the lead vocal) get a soft-mask attenuation down to ~−15dB, band-limited to 180Hz-9kHz so center bass/kick and air pass untouched; panned and uncorrelated content is untouched, so the music keeps its stereo image.
Tuning lives in the exported `CENTERCUT` config; verify any retune with the DSP E2E test (`dsp.js`), which measures center attenuation vs bass/side retention on synthetic tones and processing speed (~200ms for 30s on desktop).
Playback then applies a mild leakage-dulling graph (7kHz lowpass, −5dB peaking at 2.5kHz, slight makeup gain).
Mono tracks (or a failed centercut) fall back to the legacy realtime chain: L−R difference when stereo, peaking cuts at 1.2kHz/3kHz, 6.5kHz lowpass, 140Hz bass branch.
Processed buffers are cached (current + prefetched track) as promises keyed by URL, so replay/extend and prefetched tracks never re-process.
This path requires CORS-readable audio (`fetch` + decode), which is why song sources must serve `Access-Control-Allow-Origin: *`.
If decode fails, the caller falls back to `playElement` (plain `<audio>`, vocals intact) and shows a notice.

## Reveal playback

`revealTrack` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration−60)`), for 30s `hook` clips it starts at 0.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).
