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
}

export interface Player {
  name: string;
  score: number;
}

export interface Settings {
  mix: string;
  sound: string;
  snippetLen: number;
  eras: string[];
}

export interface GameState {
  queue: Track[];
  trackIdx: number;
  turn: number;
  round: number;
  totalSongs: number;
  source: string;
}

export interface AppState {
  screen: "setup" | "game" | "done";
  settings: Settings;
  players: Player[];
  game: GameState | null;
}

export type Phase = "ready" | "cueing" | "playing" | "guessing" | "revealed";

export interface Snippet {
  end: number;
  lastSecs: number;
  playSecs: number;
}
