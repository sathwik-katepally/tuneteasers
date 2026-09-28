export interface Track {
  title: string;
  artist: string;
  album: string;
  art: string | null;
  stream: string;
  duration: number;
  year: number;
  lang: string;
  hook: boolean;
  sourceId?: string;
  snip?: { startSec: number; endSec: number; sourceId: string; method: string; indexBuilt: string };
  tier?: string;
  music?: string;
}

export type Difficulty = "easy" | "medium" | "hard";
export type Mode = "players" | "teams";
export type Mix = "bolly" | "telugu" | "both";
export type Category = "dance" | "romantic" | "sad" | "item" | "mass";
export type Play = "pass" | "room";

export interface Settings {
  play: Play;
  mix: Mix;
  eras: string[];
  difficulty: Difficulty;
  categories: Category[];
  mode: Mode;
  rounds: number;
}

export interface RosterEntry {
  id: string;
  name: string;
  members: string[];
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
  mix: Mix;
  cast: CastMember[];
  history: HistoryEntry[];
  finished: boolean;
}

export interface AppState {
  screen: "landing" | "setup" | "game" | "done" | "past" | "host" | "buzzer";
  settings: Settings;
  players: RosterEntry[];
  teams: RosterEntry[];
  game: GameState | null;
}

export type Phase =
  | "handover"
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
  hint: boolean;
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
