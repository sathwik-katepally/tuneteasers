import type { Category, Difficulty, Track } from "../types";
import { SNIP_WINDOW_SEC } from "./constants.js";

/* Every gameplay number lives here: the clip ladder, what each rung pays,
   the speed bonus, the hint cost, the show length, the popularity cut and
   the cooldown. */

/* Each rung plays the next stretch of one continuous clip window: the first
   5s, then "Hear more" carries on for 7s. Easy keeps the vocals and plays
   from the song's hook; Music-only plays only inside a verified vocal-free
   snip window (SNIP_WINDOW_SEC), which the whole ladder has to fit. */
const CLIP_LADDER = { segments: [5, 7], points: [100, 60] } as const;

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

export const LADDER = ladder(CLIP_LADDER);
if (LADDER.end(LADDER.last) > SNIP_WINDOW_SEC)
  throw new Error(`clip ladder (${LADDER.end(LADDER.last)}s) is longer than a verified snip window (${SNIP_WINDOW_SEC}s)`);

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

/* How long a song sits out of new crates after it played through to the
   reveal. A skip records nothing. The group's PLAYED_TTL_DAYS (Worker var)
   must be at least this, or the group forgets a play too early. */
export const COOLDOWN_DAYS = 7;
// Below this many fresh songs (or fewer than the show needs), cooled-down ones come back after them; without it a device that has heard most of a small pool could not start a show until a cooldown ran out.
export const COOLDOWN_MIN_FRESH = 15;

/* The song draw favours the songs people know: a song's chance of coming up
   is proportional to (score + floor) ^ power, where score is its popularity
   percentile within its language and decade (0 to 1, corpus songs only).
   power 0 is a plain shuffle; at 2 a song at the top comes up about 6 times
   as often as one at the 30th percentile. */
export const DRAW_WEIGHT = { power: 2, floor: 0.1 } as const;

/* Both levels draw only the songs people know: a corpus song is in when its
   popularity percentile within its language and decade (score, 0 to 1) is at
   least this, so the top half. When the chosen languages, eras and categories
   leave fewer popular songs than the show needs, the crate widens to every
   song before reporting thin (not in Music-only, whose shortage the user has
   to see). */
export const POPULAR_MIN_SCORE = 0.5;

/* Buzz-in rooms (docs/room-mode.md): the host screen plays, phones buzz. */
export const ROOM_SONGS_PER_ROUND = 4;
export const ROOM_ANSWER_SECS = 20;
// After a clip ends, how long buzzing stays open before the next rung plays.
export const ROOM_GRACE_SECS = 6;
// How long a wrong answer shows on the big screen before the show moves on.
export const ROOM_WRONG_BEAT_MS = 1800;
/* Nobody has to work the big screen: the lobby starts the show this long
   after the last phone sat down, and a reveal and the box office move on by
   themselves after these. Each countdown has a tap to go now and a Pause. */
export const ROOM_AUTO_SECS = { lobby: 15, reveal: 6, board: 8 } as const;

export const MAX_MEMBERS = 6;
export const NAME_MAX = 24;

/* The pre-points version scored 1 per song (½ with a hint); a resumed old
   game is rescaled so its scores sit on the same scale as a top-rung answer. */
export const LEGACY_SCORE_SCALE = 100;

export const DIFFICULTY: Record<Difficulty, { label: string; sound: "full" | "inst"; note: string }> = {
  easy: { label: "Easy", sound: "full", note: "Big hits with the singing left in. Good for a mixed crowd." },
  medium: { label: "Medium", sound: "inst", note: "The same hits, music only. Name it from the tune." },
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
