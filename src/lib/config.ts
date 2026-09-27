import type { Category, Difficulty, Track } from "../types";

/* Every gameplay number lives here: the clip ladder, what each rung pays,
   the speed bonus, the hint cost and the show length. */

export const CLIP_STEPS = [3, 5, 8, 12] as const;
export const MUSIC_CLIP_STEPS = [3, 5, 8, 10] as const;
export const CLIP_POINTS = [100, 70, 50, 30] as const;

export const SPEED_BONUS_MAX = 20;
export const SPEED_BONUS_FADE_SECS = 13;
export const POINTS_FLOOR = 10;
export const HINT_PENALTY = 20;

export const ROUND_OPTIONS = [3, 5, 8] as const;
export const DEFAULT_ROUNDS = 5;

export const MAX_CAST = 8;
export const MAX_MEMBERS = 6;
export const NAME_MAX = 24;

/* The pre-points version scored 1 per song (½ with a hint); a resumed old
   game is rescaled so its scores sit on the same scale as a top-rung answer. */
export const LEGACY_SCORE_SCALE = 100;

export const DIFFICULTY: Record<Difficulty, { label: string; sound: "full" | "inst"; note: string }> = {
  easy: { label: "Easy", sound: "full", note: "Big hits with the singing left in. Good for a mixed crowd." },
  medium: { label: "Medium", sound: "inst", note: "A wider mix of hits, music only. Name it from the tune." },
  hard: { label: "Hard", sound: "inst", note: "Deeper album cuts, music only. For the ones who know every soundtrack." },
};

/* Song categories on the setup screen, in display order. The ids are the
   corpus tags written by scripts/build-corpus.mjs (scripts/corpus.config.json). */
export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "dance", label: "Dance & party" },
  { id: "romantic", label: "Romantic" },
  { id: "sad", label: "Sad" },
  { id: "item", label: "Item songs" },
  { id: "mass", label: "Mass beats" },
];

/* The bonus stays full while a clip is still playing and fades once the
   current rung's clip has finished, so waiting costs a little, never a lot. */
export function speedBonus(clipEndedAt: number | null, now: number): number {
  if (clipEndedAt === null) return SPEED_BONUS_MAX;
  const waited = Math.max(0, (now - clipEndedAt) / 1000);
  return Math.max(0, Math.round(SPEED_BONUS_MAX * (1 - waited / SPEED_BONUS_FADE_SECS)));
}

export function pointsNow(rung: number, clipEndedAt: number | null, hint: boolean, now = Date.now()): number {
  const base = CLIP_POINTS[Math.min(rung, CLIP_POINTS.length - 1)];
  return Math.max(POINTS_FLOOR, base + speedBonus(clipEndedAt, now) - (hint ? HINT_PENALTY : 0));
}

/* A likely hook for full-length songs: past the intro, clear of the outro.
   30s preview clips are already a hook, so they start at 0. */
export const hookOffset = (t: Track) => (t.duration > 35 ? Math.min(45, Math.max(0, t.duration - 60)) : 0);
