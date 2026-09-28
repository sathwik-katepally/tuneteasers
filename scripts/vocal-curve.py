#!/usr/bin/env python3
"""Vocal-stem curves for the snips scorer (scripts/build-snips.mjs).

Reads one JSON job per stdin line and answers each with one stdout line
(or {"id", "error"}):

  {"op": "song", "id", "url", "lang"}
    Decodes the whole stream with ffmpeg, separates the vocal stem with
    htdemucs, and returns the loudness (dBFS) of the stem and of the mix per
    0.1s block ("stem", "mix"), plus every word Whisper recognises in the
    stem as [start, end, probability] ("words").
  {"op": "confirm", "id", "url", "lang", "from", "to"}
    Separates only [from, to) seconds with Mel-Band RoFormer, a second
    separator of another design, and returns the same "stem" and "words"
    for that stretch, timed from the song's start.

The scorer turns these into stored curves and judges windows from them.

  python3 scripts/vocal-curve.py [--raw DIR]

--raw keeps each song's full-resolution levels and every Whisper segment in
DIR (for calibration and audits); the scorer never needs them.
"""
import argparse, json, os, subprocess, sys, time

os.environ.setdefault("TQDM_DISABLE", "1")  # the separators' progress bars would flood CI logs
import numpy as np

SR = 44100
BLOCK = 4410  # 0.1s
ROFORMER = "vocals_mel_band_roformer.ckpt"
WHISPER = "large-v3-turbo"
LANG = {"bolly": "hi", "hindi": "hi", "telugu": "te"}


def decode(url, start=None, secs=None, min_secs=20):
    clip = ["-ss", str(start), "-t", str(secs)] if start is not None else []
    for attempt in range(3):
        p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-rw_timeout", "30000000", *clip, "-i", url,
                            "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True)
        if p.returncode == 0 and len(p.stdout) >= SR * 8 * min_secs:
            return np.frombuffer(p.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
        err = p.stderr.decode(errors="replace").strip()[-200:] or f"{len(p.stdout)} bytes"
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"decode: {err}")


class Demucs:
    def __init__(self, device):
        import torch
        from demucs.pretrained import get_model
        self.torch, self.device = torch, device
        self.model = get_model("htdemucs").eval()
        self.vi = self.model.sources.index("vocals")

    def vocals(self, mix):
        from demucs.apply import apply_model
        t = self.torch.from_numpy(mix)
        with self.torch.no_grad():
            out = apply_model(self.model, t[None], device=self.device, shifts=0, split=True, overlap=0.25, progress=False)
        return out[0, self.vi].cpu().numpy()


class Roformer:
    def __init__(self, model_file, model_dir):
        import logging
        from audio_separator.separator import Separator
        # overlap 2 instead of the default 8: a quarter of the compute, and
        # only the stem's loudness is measured, not its sound quality.
        sep = Separator(log_level=logging.WARNING, model_file_dir=model_dir, output_dir=model_dir,
                        mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                     "batch_size": 1, "overlap": 2, "pitch_shift": 0})
        sep.load_model(model_file)
        self.m = sep.model_instance

    def vocals(self, mix):
        out = self.m.demix(mix.copy())
        key = next(k for k in out if k.lower() == "vocals")
        return np.asarray(out[key], dtype=np.float32)


def block_db(x):
    n = x.shape[-1] // BLOCK
    p = (x[..., : n * BLOCK].reshape(x.shape[0], n, BLOCK) ** 2).mean(axis=(0, 2))
    return 10 * np.log10(p + 1e-12)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.environ.get("SNIP_MODELS", os.path.expanduser("~/.cache/tt-snips-models")))
    ap.add_argument("--device", default=os.environ.get("SNIP_DEVICE", "cpu"))
    ap.add_argument("--raw")
    a = ap.parse_args()
    import torch
    torch.set_num_threads(os.cpu_count() or 4)
    torch.hub.set_dir(os.path.join(a.models, "torch"))
    if a.device == "cpu":
        # audio-separator picks MPS/CUDA on its own when it sees one
        torch.backends.mps.is_available = lambda: False
        torch.cuda.is_available = lambda: False
    os.makedirs(a.models, exist_ok=True)
    demucs, roformer = Demucs(a.device), Roformer(ROFORMER, a.models)
    from faster_whisper import WhisperModel
    from scipy.signal import resample_poly
    asr = WhisperModel(WHISPER, device="cpu", compute_type="int8", download_root=os.path.join(a.models, "whisper"))
    if a.raw:
        os.makedirs(a.raw, exist_ok=True)
    print(json.dumps({"ready": True, "separators": ["htdemucs", ROFORMER], "whisper": WHISPER}), flush=True)

    def transcribe(voc, lang, offset=0.0):
        mono16 = resample_poly(voc.mean(0), 160, 441).astype(np.float32)
        segs, _ = asr.transcribe(mono16, language=LANG.get(lang), beam_size=1, word_timestamps=True,
                                 condition_on_previous_text=False, vad_filter=False)
        segs = list(segs)
        words = [[round(w.start + offset, 2), round(w.end + offset, 2), round(w.probability, 3)] for s in segs for w in (s.words or [])]
        return segs, words

    rounded = lambda x: np.round(x.astype(np.float64), 1).tolist()
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        t0 = time.time()
        try:
            if job.get("op") == "confirm":
                start = max(0, int(job["from"]))
                mix = decode(job["url"], start, int(job["to"]) - start, min_secs=1)
                voc = roformer.vocals(mix)[:, : mix.shape[1]]
                t1 = time.time()
                _, words = transcribe(voc, job.get("lang"), start)
                out = {"id": job["id"], "from": start, "stem": rounded(block_db(voc)), "words": words}
            else:
                mix = decode(job["url"])
                voc = demucs.vocals(mix)[:, : mix.shape[1]]
                t1 = time.time()
                stem_db, mix_db = block_db(voc), block_db(mix)
                segs, words = transcribe(voc, job.get("lang"))
                if a.raw:
                    np.savez_compressed(os.path.join(a.raw, f"{job['id']}.npz"), stem=stem_db.astype(np.float16), mix=mix_db.astype(np.float16))
                    with open(os.path.join(a.raw, f"{job['id']}.json"), "w") as f:
                        json.dump({"segments": [{"start": s.start, "end": s.end, "text": s.text, "no_speech": s.no_speech_prob,
                                                 "logprob": s.avg_logprob, "cr": s.compression_ratio,
                                                 "words": [[w.start, w.end, w.probability, w.word] for w in (s.words or [])]} for s in segs]}, f, ensure_ascii=False)
                out = {"id": job["id"], "dur": round(mix.shape[1] / SR, 2), "stem": rounded(stem_db), "mix": rounded(mix_db), "words": words}
            out["ms"] = {"separate": round((t1 - t0) * 1000), "total": round((time.time() - t0) * 1000)}
        except Exception as e:
            out = {"id": job.get("id"), "error": f"{type(e).__name__}: {e}"[:300]}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
