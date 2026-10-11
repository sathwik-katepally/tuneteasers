#!/usr/bin/env python3
"""Vocal-stem curves for the snips scorer (scripts/build-snips.mjs).

Reads one JSON job per stdin line, {"id", "url"}, and answers each with one
stdout line: the whole stream decoded with ffmpeg and separated with
htdemucs, as the loudness (dBFS) of the vocal stem and of the mix per 0.1s
block ("stem", "mix"), or {"id", "error"}.

  python3 scripts/vocal-curve.py [--raw DIR]

--raw keeps each song's full-resolution levels in DIR (for audits); the
scorer never needs them.
"""
import argparse, json, os, subprocess, sys, time

os.environ.setdefault("TQDM_DISABLE", "1")  # the separator's progress bar would flood CI logs
import numpy as np

SR = 44100
BLOCK = 4410  # 0.1s


def decode(url, min_secs=20):
    for attempt in range(3):
        p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-rw_timeout", "30000000", "-i", url,
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
    os.makedirs(a.models, exist_ok=True)
    demucs = Demucs(a.device)
    if a.raw:
        os.makedirs(a.raw, exist_ok=True)
    print(json.dumps({"ready": True, "separator": "htdemucs"}), flush=True)

    rounded = lambda x: np.round(x.astype(np.float64), 1).tolist()
    for line in sys.stdin:
        if not line.strip():
            continue
        job = json.loads(line)
        t0 = time.time()
        try:
            mix = decode(job["url"])
            voc = demucs.vocals(mix)[:, : mix.shape[1]]
            stem_db, mix_db = block_db(voc), block_db(mix)
            if a.raw:
                np.savez_compressed(os.path.join(a.raw, f"{job['id']}.npz"), stem=stem_db.astype(np.float16), mix=mix_db.astype(np.float16))
            out = {"id": job["id"], "dur": round(mix.shape[1] / SR, 2), "stem": rounded(stem_db), "mix": rounded(mix_db),
                   "ms": round((time.time() - t0) * 1000)}
        except Exception as e:
            out = {"id": job.get("id"), "error": f"{type(e).__name__}: {e}"[:300]}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
