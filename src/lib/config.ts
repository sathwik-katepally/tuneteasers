import type { Category, Difficulty, Track } from "../types";
import { SNIP_WINDOW_SEC } from "./constants.js";

/* Every gameplay number lives here: the clip ladder, what each rung pays,
   the speed bonus, the hint cost, the show length, skips and cooldowns. */

/* Each rung plays the next stretch of one continuous clip window: the first
   5s, then "Hear more" carries on for 7s, then 8s. Easy keeps the vocals and
   plays from the song's hook, so its window is free. Music-only plays only
   inside a verified vocal-free snip window (SNIP_WINDOW_SEC), so its ladder
   stops at 12s; give it the third rung again once the index holds enough
   20s windows (a longer SNIP_WINDOW_SEC and a rescore, docs/audio.md). */
const CLIP_LADDERS = {
  full: { segments: [5, 7, 8], points: [100, 60, 30] },
  inst: { segments: [5, 7], points: [100, 60] },
} as const;

export interface Ladder {
  segments: readonly number[];
  points: readonly number[];
  last: number;
  /* Seconds into the clip window where a rung starts and stops. */
  start: (rung: number) => number;
  end: (rung: number) => number;
  /* What a play of `rung` covers: "Hear more" plays only the new stretch, a
     replay plays everything heard so far from the top. */
  span: (rung: number, replay: boolean) => { from: number; to: number };
}

function ladder({ segments, points }: { segments: readonly number[]; points: readonly number[] }): Ladder {
  if (segments.length !== points.length) throw new Error("every clip rung needs its points");
  const last = segments.length - 1;
  const end = (rung: number) => segments.slice(0, Math.min(rung, last) + 1).reduce((a, b) => a + b, 0);
  const start = (rung: number) => (rung > 0 ? end(rung - 1) : 0);
  return { segments, points, last, start, end, span: (rung, replay) => ({ from: replay ? 0 : start(rung), to: end(rung) }) };
}

const LADDERS = { full: ladder(CLIP_LADDERS.full), inst: ladder(CLIP_LADDERS.inst) };
if (LADDERS.inst.end(LADDERS.inst.last) > SNIP_WINDOW_SEC)
  throw new Error(`music-only clip ladder (${LADDERS.inst.end(LADDERS.inst.last)}s) is longer than a verified snip window (${SNIP_WINDOW_SEC}s)`);

/* plain: the song plays as-is (Easy); otherwise it is Music-only. */
export const ladderFor = (plain: boolean): Ladder => LADDERS[plain ? "full" : "inst"];

export const SPEED_BONUS_MAX = 20;
export const SPEED_BONUS_FADE_SECS = 13;
const POINTS_FLOOR = 10;
export const HINT_PENALTY = 20;
/* Hints come one tap at a time, least telling first, each costing HINT_PENALTY.
   The film goes last because naming the film scores. */
const HINT_ORDER = ["year", "music", "singers", "film"] as const;
/* A contestant can pass a song on round the table instead of giving up; whoever
   steals it scores this share of what it is worth then, never below the floor. */
export const STEAL_SHARE = 0.5;

export const ROUND_OPTIONS = [3, 5, 8] as const;
export const DEFAULT_ROUNDS = 5;

export const MAX_CAST = 8;
export const MIN_CAST = { players: 1, teams: 2 } as const;

/* "Heard it too much" in pass-the-phone: each contestant's free skips per show.
   A skip after a stream error is always free. The room's vote share and skip
   cap are Worker vars (worker/wrangler.jsonc), since the room enforces them. */
export const SKIPS_PER_PLAYER = 1;

/* How long a song sits out of new crates, by how it last left: played through,
   or skipped as heard too much. The group's PLAYED_TTL_DAYS (Worker var) must
   be at least the longest of these, or the group forgets a skip too early. */
export const COOLDOWN_DAYS = { played: 7, tired: 30 } as const;
// Below this many fresh songs, cooled-down ones come back after them; without it a device that has heard most of a small pool could not start a show until a cooldown ran out.
export const COOLDOWN_MIN_FRESH = 15;

/* Buzz-in rooms (docs/room-mode.md): the host screen plays, phones buzz. */
export const ROOM_SONGS_PER_ROUND = 4;
export const ROOM_ANSWER_SECS = 15;
// After a clip ends, how long buzzing stays open before the next rung plays.
export const ROOM_GRACE_SECS = 6;
// How long a wrong answer shows on the big screen before the show moves on.
export const ROOM_WRONG_BEAT_MS = 1800;

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
function speedBonus(clipEndedAt: number | null, now: number): number {
  if (clipEndedAt === null) return SPEED_BONUS_MAX;
  const waited = Math.max(0, (now - clipEndedAt) / 1000);
  return Math.max(0, Math.round(SPEED_BONUS_MAX * (1 - waited / SPEED_BONUS_FADE_SECS)));
}

export function pointsNow(l: Ladder, rung: number, clipEndedAt: number | null, hints: number, now = Date.now(), steal = false): number {
  const base = l.points[Math.min(rung, l.last)];
  const full = Math.max(POINTS_FLOOR, base + speedBonus(clipEndedAt, now) - hints * HINT_PENALTY);
  return steal ? Math.max(POINTS_FLOOR, Math.round(full * STEAL_SHARE)) : full;
}

/* The hints a song has, in HINT_ORDER; a detail missing from its record is left out. */
export function hintsFor(t: Track): string[] {
  const text = { year: t.year > 0 ? `Released in ${t.year}` : "", music: t.music ? `Music by ${t.music}` : "",
    singers: t.artist ? `Sung by ${t.artist}` : "", film: t.album ? `From ${t.album}` : "" };
  return HINT_ORDER.map(k => text[k]).filter(Boolean);
}

/* A likely hook for full-length songs: past the intro, clear of the outro.
   30s preview clips are already a hook, so they start at 0. */
export const hookOffset = (t: Track) => (t.duration > 35 ? Math.min(45, Math.max(0, t.duration - 60)) : 0);
