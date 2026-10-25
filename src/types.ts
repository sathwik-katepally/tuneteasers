import type { Lang } from "./lib/languages";

export type { Lang };

export interface Track {
  title: string;
  artist: string;
  album: string;
  art: string | null;
  stream: string;
  duration: number;
  year: number;
  lang: Lang;
  hook: boolean;
  sourceId?: string;
  snip?: { startSec: number; endSec: number; sourceId: string; method: string; indexBuilt: string };
  /* Popularity percentile within the song's language and decade (corpus songs only). */
  score?: number;
  music?: string;
}

export type Difficulty = "easy" | "medium";
export type Mode = "players" | "teams";
/* "hits": the popular songs only; "more": the less famous ones as well. */
export type Songs = "hits" | "more";
export type Category = "dance" | "romantic" | "sad" | "item" | "mass" | "hiphop";
export type Play = "pass" | "room";

export interface Settings {
  play: Play;
  langs: Lang[];
  eras: string[];
  difficulty: Difficulty;
  songs: Songs;
  categories: Category[];
  mode: Mode;
  rounds: number;
}

export interface RosterEntry {
  id: string;
  name: string;
  members: string[];
  /* Pass the phone: the language this contestant's own turns play; absent, any chosen language. */
  lang?: Lang;
}

export interface CastMember extends RosterEntry {
  score: number;
}

export interface HistoryEntry {
  id: string;
  song: string;
  points: number;
  round: number;
}

export interface GameState {
  id: string;
  queue: Track[];
  trackIdx: number;
  turn: number;
  round: number;
  totalRounds: number;
  totalSongs: number;
  source: string;
  mode: Mode;
  difficulty: Difficulty;
  langs: Lang[];
  cast: CastMember[];
  history: HistoryEntry[];
  finished: boolean;
}

export interface AppState {
  screen: "landing" | "setup" | "game" | "done" | "past" | "group" | "host" | "buzzer";
  settings: Settings;
  players: RosterEntry[];
  teams: RosterEntry[];
  game: GameState | null;
}

export type Phase =
  | "handover"
  | "steal"
  | "countdown"
  | "cueing"
  | "playing"
  | "listened"
  | "blocked"
  | "reveal"
  | "board";

export interface Turn {
  rung: number;
  /* Seconds into the clip window the current play covers. */
  span: { from: number; to: number };
  clipEndedAt: number | null;
  clipStartedAt: number;
  playKey: number;
  /* How many hints have been shown (hintsFor). */
  hints: number;
  /* A buzz stopped the clip before its end (rooms), so the next play starts from the top of the window. */
  cut: boolean;
}

export interface Verdict {
  name: string;
  result: "correct" | "wrong";
  points: number;
  total: number;
  roundOver: boolean;
  finished: boolean;
  completedRound: number;
}
