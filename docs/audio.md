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
The detector chooses the WINDOW but never gets to skip processing: wide/doubled vocals evade center-correlation entirely (measured twice: 11/12 real songs scored "clean" under the old trusting verdict, and 7/8 under the later "conservative" one while still carrying audible vocals - the chosen window is the song's own minimum, so the below-spread condition is nearly always true).
The "clean" verdict is therefore telemetry only, logged with its numbers (`best`/`p20`/`p80`/`contrast`) for future tuning; on the DSP path every window is processed with `centerCut`, and raw playback exists only as ML output (mode "ml").
The kept buffer is the 45s slice starting at the chosen window, so all snippet offsets are relative to that start.

## Centercut (fallback vocal reduction)

`centerCut` from `src/lib/centercut.js` runs offline on the sliced buffer.
`centerCut` is per-bin center-channel suppression: an STFT (fft.js, 2048-point, 50% overlap, sqrt-Hann analysis+synthesis windows), where bins with near-identical L/R content (center-panned = almost always the lead vocal) get a soft-mask attenuation down to ~−15dB, band-limited to 180Hz-9kHz so center bass/kick and air pass untouched; panned and uncorrelated content is untouched, so the music keeps its stereo image.
Tuning lives in the exported `CENTERCUT` and `SNIPPICK` configs; verify any retune with the DSP E2E tests (`dsp.js` for suppression depth vs bass/side retention, `pick.js` for window selection and the per-song clean verdict).
Centercut playback applies a mild leakage-dulling graph (7kHz lowpass, −5dB peaking at 2.5kHz, slight makeup gain).
Mono tracks (or a failed centercut) fall back to the legacy realtime chain: L−R difference when stereo, peaking cuts at 1.2kHz/3kHz, 6.5kHz lowpass, 140Hz bass branch.

## ML separation (vocal windows, capable devices)
On any WebGPU device, `src/lib/mlsep.js` runs true vocal separation on every picked window (the DSP paths are fallback-only): the public UVR MDX-Net Inst_HQ_3 model (ONNX, ~64MB; do NOT use the VIP models — they are for UVR's paying subscribers) executes on WebGPU via onnxruntime-web.
The model downloads from Hugging Face on first use and persists in the browser Cache API; the site hosts neither model nor audio.
`src/lib/mdx.js` is the runtime-agnostic STFT/chunk/iSTFT plumbing around the model (n_fft 6144 via a mixed-radix FFT of three fft.js 2048 transforms); it was batch-validated against the reference audio-separator implementation on 8 real songs (waveform correlation ≥ 0.974, vocals removed 2.5-12.6dB; the final ~1.5s of a clip legitimately diverges from the reference due to different tail chunking).
Inputs are peak-normalized to 0.9 before inference (matching UVR) and rescaled after.
Audio is resampled to 44.1kHz for inference (the model's training rate) and back for playback.
Devices without WebGPU skip ML, and so does iOS (Safari's per-tab memory limit jetsam-kills the tab under the model + WebGPU session load, reloading the page mid-game); a device that blows the 75s inference budget is remembered in localStorage (`tt_ml_slow`) and skips ML from then on.
ML never blocks the first play: inference gets a ~3.5s head start, after which the DSP result (raw/centercut/legacy) plays and the cache entry is upgraded in place to the ML buffer (mode "ml") once inference lands, so replays, extends, and prefetched tracks read the upgraded audio.
This makes `window.__ttLastMode` time-dependent on ML-capable devices (it flips to "ml" when the upgrade lands), and an extend can audibly switch from centercut to ML separation mid-round - same window, strictly better separation.
Successful ML output plays raw; any failure falls through to centercut/legacy silently.
The `onnxruntime-web` version is pinned exactly and must match the CDN wasmPaths in mlsep.js; vite resolves the extern-wasm build via a custom condition in vite.config.js.
Processed buffers are cached (current + prefetched track) as promises keyed by URL, so replay/extend and prefetched tracks never re-process.
The app warms the NEXT track's full pipeline (fetch, decode, window pick, separation) in the background as soon as the current track's buffer resolves, so from round 2 onward the snippet cue is a cache hit (~0ms); only the first track of a game pays the pipeline cold.
`playMuffled` bounds the cueing wait at 15s: a stalled stream fetch falls back to `playElement` (as-is playback with a notice) instead of pinning the game on "Cueing it up…", while the background load keeps running so later replays can still hit the cache.
This path requires CORS-readable audio (`fetch` + decode), which is why song sources must serve `Access-Control-Allow-Origin: *`.
If decode fails, the caller falls back to `playElement` (plain `<audio>`, vocals intact) and shows a notice.

## Reveal playback

`revealTrack` plays the unfiltered song via `playElement`; for full-length tracks it seeks toward a likely hook (`min(45, duration−60)`), for 30s `hook` clips it starts at 0.

## Wake lock

`keepAwake(true)` requests a screen wake lock while the game screen is active and re-acquires it on visibility change; failures are ignored (unsupported browsers).

## Diagnostics

`src/lib/log.js` keeps a structured ring buffer (250 entries) of pipeline events: boot (with ML availability reason), crate tier results, per-track load timings and window-pick verdict numbers, the resolved mode, ML model/session/inference events, and every fallback (`cue-fail`, `centercut-fail`, `muffle-fallback`, `element-play`, `element-fail`).
The buffer mirrors to the console and persists in localStorage, so a tab reload keeps the evidence; a `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off); `window.__ttLog.dump()` reads it programmatically, and the E2E evidence script (`/tmp/tt-e2e/evidence.js`) aggregates mode distribution per run.
