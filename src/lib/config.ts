import type { Category, Difficulty, Track } from "../types";
import { SNIP_WINDOW_SEC } from "./constants.js";

/* Every gameplay number lives here: the clip ladder, what each rung pays,
   the speed bonus, the hint cost and the show length. */

/* Each rung plays the next stretch of one continuous clip window: the first
   5s, then "Hear more" carries on for 7s, then 8s. Music-only windows are
   verified vocal-free for their whole length, so the ladder must fit one. */
export const CLIP_SEGMENTS = [5, 7, 8] as const;
export const CLIP_POINTS = [100, 60, 30] as const;
export const LAST_RUNG = CLIP_SEGMENTS.length - 1;

/* Seconds into the clip window where a rung stops. */
export const rungEnd = (rung: number) => CLIP_SEGMENTS.slice(0, Math.min(rung, LAST_RUNG) + 1).reduce((a, b) => a + b, 0);
export const rungStart = (rung: number) => (rung > 0 ? rungEnd(rung - 1) : 0);
export const CLIP_WINDOW = rungEnd(LAST_RUNG);
if (CLIP_WINDOW > SNIP_WINDOW_SEC) throw new Error(`clip ladder (${CLIP_WINDOW}s) is longer than a verified snip window (${SNIP_WINDOW_SEC}s)`);

/* What a play of `rung` covers inside the window: "Hear more" plays only the
   new stretch, a replay plays everything heard so far from the top. */
export const rungSpan = (rung: number, replay: boolean) => ({ from: replay ? 0 : rungStart(rung), to: rungEnd(rung) });

export const SPEED_BONUS_MAX = 20;
export const SPEED_BONUS_FADE_SECS = 13;
export const POINTS_FLOOR = 10;
export const HINT_PENALTY = 20;

export const ROUND_OPTIONS = [3, 5, 8] as const;
export const DEFAULT_ROUNDS = 5;

export const MAX_CAST = 8;

/* Buzz-in rooms (docs/room-mode.md): the host screen plays, phones buzz. */
export const ROOM_SONGS_PER_ROUND = 4;
export const ROOM_ANSWER_SECS = 15;
// After a clip ends, how long buzzing stays open before the next rung plays.
export const ROOM_GRACE_SECS = 6;
// How long a wrong answer shows on the big screen before the show moves on.
export const ROOM_WRONG_BEAT_MS = 1800;
// Queued songs past the show length, in case some will not stream.
export const ROOM_SPARE_SONGS = 6;
export const ROOM_DECOYS_PER_SONG = 3;
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
