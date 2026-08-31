# Audio engine

All playback goes through the `engine` singleton in `src/lib/engine.js`; it is the only owner of audio output.

## Session rule (concurrency safety)

Every `stop()`/play call bumps `engine.session`; async continuations capture the session number and abort if it changed.
This guarantees two songs can never play at once, even when the user mashes buttons while a fetch/decode is in flight.
`playMuffled` returns `"played" | "failed" | "superseded"`; callers must treat `"superseded"` as "do nothing" (a newer user action owns playback).

## Vocal handling (default "Music only" mode)

Strategy: find where the song is instrumental AND suppress whatever vocals remain — both halves are needed for the doubled/reverbed leads typical of these mixes.
`playMuffled` fetches the stream, decodes the full song, then picks the most instrumental ~25s window using two pickers that run in parallel:
the primary is `pickWindowVAD` (`src/lib/vad.js`) — the essentia `voice_instrumental-musicnn-msd-2` MusiCNN classifier (3MB, self-hosted under `public/models/`, CC BY-NC-SA 4.0, (c) Music Technology Group, Universitat Pompeu Fabra) scoring p(voice) per ~6s patch on the tfjs WASM backend in a worker (`src/lib/vad.worker.js`), picking the window whose worst patch is quietest;
the fallback is the `pickSnippetWindow` heuristic (`src/lib/snippick.js`, center-correlated energy in the 200Hz-4kHz band), used when the VAD misses its time cap or fails.
The VAD gets 10s on patient (background-warming) loads and 4s on impatient ones; a `playMuffled` call on a still-pending load pokes the wait short so a user tap never sits out the cap; verdicts persist per stream URL in localStorage (`tt_vad`), so a song's next appearance uses its VAD window instantly.
The VAD is skipped on iOS (`vadReason()` in `src/lib/vad.js`), the same policy as ML separation: the essentia mel extraction leaks WASM heap per frame it processes (measured: the tab's process grew by over 1GB per scored song, and WASM memory never shrinks), which jetsam-kills the tab mid-game; snippick is the picker there.
Everywhere else, mel is extracted per kept patch (sample-aligned segments, verified bit-identical to a full-song pass) so the stride-2 patch skip also halves the leak, and the worker is terminated after every job — success or failure — because that is the only way to reclaim the leaked heap; reusing a worker also corrupts the essentia WASM heap after a few songs (observed on WebKit: "Out of bounds memory access", then aborts).
The detector chooses the WINDOW but never gets to skip processing: wide/doubled vocals evade center-correlation entirely (measured twice: 11/12 real songs scored "clean" under the old trusting verdict, and 7/8 under the later "conservative" one while still carrying audible vocals - the chosen window is the song's own minimum, so the below-spread condition is nearly always true).
The "clean" verdict is therefore telemetry only, logged with its numbers (`best`/`p20`/`p80`/`contrast`) for future tuning; on the DSP path every window is processed with `centerCut`, and raw playback exists only as ML output (mode "ml").
The kept buffer is the 45s slice starting at the chosen window, so all snippet offsets are relative to that start.

## Suppression cascade (DSP path)

`suppressVocals` from `src/lib/suppress.js` runs offline on the sliced buffer (mode "cut"); it replaced the old single-cue centercut.
Three independent cues combine over one STFT geometry (fft.js, 2048-point, 50% overlap, sqrt-Hann analysis+synthesis):
a per-bin center mask (near-identical L/R content ducked, soft mask), a REPET-SIM mask (per-frame k-nearest-neighbor search over pooled log-mel features with a +-2.5s self-match exclusion, per-bin median over the k=25 most-similar frames modeling the repeating accompaniment; non-repeating energy — the vocal, however panned — gets ducked), and an HPSS percussive mask (17-tap median filters, Driedger margin 2) whose output is re-injected at 0.9 so drums stay loud and perceptually bury residue.
Center and REPET masks multiply (suppression adds in dB where cues agree) and are raised to combinePow 1.35; the band reaches 180Hz-14kHz so sibilants are treated, with a floor of ~-15dB outside and ~-24dB inside the 1-8kHz consonant region.
The O(T^2) similarity search is decimated 2x in both frames and candidates (4x less work); measured: center synthetic vocal -24.4dB, decorrelated wide vocal -13.2dB, bass and panned instruments 0dB, 30s stereo in ~1.4s (Chromium).
Cut playback applies a mild graph (12kHz lowpass, -5dB peaking at 2.5kHz, slight makeup gain).
Tuning lives in the exported `SUPPRESS` and `SNIPPICK` configs; verify any retune with the DSP E2E tests (`dsp.js` for suppression depth vs bass/side retention, `pick.js` for the heuristic picker, `vadtest.js` for the VAD).
Mono tracks (or a failed suppression) fall back to the legacy realtime chain: L-R difference when stereo, peaking cuts at 1.2kHz/3kHz, 6.5kHz lowpass, 140Hz bass branch.

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

`src/lib/log.js` keeps a structured ring buffer (250 entries) of pipeline events: boot (with ML availability reason), crate tier results, per-track load timings and window-pick verdict numbers, the resolved mode and picker, VAD scoring results (`vad`, `vad-fail`), ML model/session/inference events, and every fallback (`cue-fail`, `suppress-fail`, `muffle-fallback`, `element-play`, `element-fail`).
The buffer mirrors to the console and persists in localStorage, so a tab reload keeps the evidence; a `boot` entry with no preceding `pagehide` is the signature of a crash or jetsam kill.
On any device, append `?debug=1` to the URL for a live on-screen log overlay with copy-to-clipboard (`?debug=0` turns it off); the panel opens itself when the param is present, since the collapsed "log" fab can sit behind a real iPhone's bottom browser toolbar.
`window.__ttLog.dump()` reads the log programmatically, and the E2E evidence script (`/tmp/tt-e2e/evidence.js`) aggregates mode distribution per run.
