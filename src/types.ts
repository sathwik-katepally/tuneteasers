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
  snip?: number;
  music?: string;
}

export type Difficulty = "easy" | "medium" | "hard";
export type Mode = "players" | "teams";
export type Mix = "bolly" | "telugu" | "both";

export interface Settings {
  mix: Mix;
  eras: string[];
  difficulty: Difficulty;
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
  queue: Track[];
  trackIdx: number;
  turn: number;
  round: number;
  totalRounds: number;
  totalSongs: number;
  source: string;
  mode: Mode;
  difficulty: Difficulty;
  cast: CastMember[];
  history: HistoryEntry[];
  finished: boolean;
}

export interface AppState {
  screen: "setup" | "game" | "done";
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
  | "guessing"
  | "reveal"
  | "board";

export interface Turn {
  rung: number;
  clipEndedAt: number | null;
  clipStartedAt: number;
  playKey: number;
  hint: boolean;
  locked: number;
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
