# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while a fetch/decode is in flight.
`playMuffled` returns `"played" | "failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).

## Vocal handling (default "Music only" mode)

Strategy: find where the song is instrumental instead of trying to erase vocals — channel-based vocal removal cannot fully strip the doubled/reverbed leads typical of these mixes, but detecting vocal activity is reliable.
`playMuffled` fetches the stream, decodes the full song, then `pickSnippetWindow` (`src/lib/snippick.js`) scores every STFT frame for vocal activity (center-correlated energy in the 200Hz-4kHz band) and picks the most instrumental ~25s window.
Every decision is song-adaptive, never a fixed absolute threshold: the silence guard compares frame energy to the song's own median, and the "clean" verdict compares the best window to the song's own score percentiles.
A clean window plays completely raw (mode "raw" — full-quality audio, no artifacts).
If the song never goes instrumental, its least-vocal window is kept and processed with `centerCut` (below).
The kept buffer is the 45s slice starting at the chosen window, so all snippet offsets are relative to that start.

## Centercut (fallback vocal reduction)

`centerCut` from `src/lib/centercut.js` runs offline on the sliced buffer.
`centerCut` is per-bin center-channel suppression: an STFT (fft.js, 2048-point, 50% overlap, sqrt-Hann analysis+synthesis windows), where bins with near-identical L/R content (center-panned = almost always the lead vocal) get a soft-mask attenuation down to ~−15dB, band-limited to 180Hz-9kHz so center bass/kick and air pass untouched; panned and uncorrelated content is untouched, so the music keeps its stereo image.
Tuning lives in the exported `CENTERCUT` and `SNIPPICK` configs; verify any retune with the DSP E2E tests (`dsp.js` for suppression depth vs bass/side retention, `pick.js` for window selection and the per-song clean verdict).
Centercut playback applies a mild leakage-dulling graph (7kHz lowpass, −5dB peaking at 2.5kHz, slight makeup gain).
Mono tracks (or a failed centercut) fall back to the legacy realtime chain: L−R difference when stereo, peaking cuts at 1.2kHz/3kHz, 6.5kHz lowpass, 140Hz bass branch.
Processed buffers are cached (current + prefetched track) as promises keyed by URL, so replay/extend and prefetched tracks never re-process.
This path requires CORS-readable audio (`fetch` + decode), which is why song sources must serve `Access-Control-Allow-Origin: *`.
If decode fails, the caller falls back to `playElement` (plain `<audio>`, vocals intact) and shows a notice.

## Reveal playback

`revealTrack` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration−60)`), for 30s `hook` clips it starts at 0.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).
