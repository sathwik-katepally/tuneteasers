/* The saved game: written on every state change, restored and sanitized on
   boot. A page load lands on the home screen (the landing page on a first
   visit); an unfinished game is offered there as a Resume card. Saves from the pre-points version
   (tuneteasers_v6) are migrated once, then that key is dropped. */
import { ERAS } from "./constants.js";
import { sanitizeTrack } from "./storage";
import { isResultId, randomId } from "./group";
import { CATEGORIES, DEFAULT_ROUNDS, LEGACY_SCORE_SCALE, MAX_CAST, MAX_MEMBERS, NAME_MAX, ROUND_OPTIONS } from "./config";
import type { AppState, CastMember, Category, Difficulty, GameState, HistoryEntry, Mix, Mode, Play, RosterEntry, Settings, Track } from "../types";

const KEY = "tuneteasers_v7";
const LEGACY_KEY = "tuneteasers_v6";
const LANDING_SEEN_KEY = "tt_landing_seen";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? v as Raw : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown, fallback: number) => { const n = parseInt(String(v)); return Number.isFinite(n) ? n : fallback; };
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  (options as readonly unknown[]).includes(v) ? v as T : fallback;

function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

export const newId = () => Math.random().toString(36).slice(2, 10);
export const cleanName = (v: unknown, fallback: string) => String(v ?? "").trim().slice(0, NAME_MAX) || fallback;

const DEFAULTS: AppState = {
  screen: "setup",
  settings: { play: "pass", mix: "both", eras: [...ERAS], difficulty: "medium", categories: [], mode: "players", rounds: DEFAULT_ROUNDS },
  players: [
    { id: "p1", name: "Player 1", members: [] },
    { id: "p2", name: "Player 2", members: [] },
  ],
  teams: [
    { id: "t1", name: "Balcony", members: [] },
    { id: "t2", name: "Stalls", members: [] },
  ],
  game: null,
};

/* The era control offers one era or all; a save with two (the v6 UI allowed it)
   would show as All while filtering, so it loads as all. */
function parseEras(v: unknown): string[] {
  const eras = ERAS.filter(e => arr(v).includes(e));
  return eras.length === 1 ? eras : [...ERAS];
}

/* Any (every song) is the empty list, which is also what saves from before categories load as. */
function parseCategories(v: unknown): Category[] {
  return CATEGORIES.map(c => c.id).filter(id => arr(v).includes(id));
}

function parseSettings(raw: Raw): Settings {
  return {
    play: oneOf<Play>(raw.play, ["pass", "room"], "pass"),
    mix: oneOf<Mix>(raw.mix, ["bolly", "telugu", "both"], "both"),
    eras: parseEras(raw.eras),
    difficulty: oneOf<Difficulty>(raw.difficulty, ["easy", "medium", "hard"], "medium"),
    categories: parseCategories(raw.categories),
    mode: oneOf<Mode>(raw.mode, ["players", "teams"], "players"),
    rounds: (ROUND_OPTIONS as readonly number[]).includes(raw.rounds as number) ? raw.rounds as number : DEFAULT_ROUNDS,
  };
}

function parseRoster(v: unknown, fallback: RosterEntry[], prefix: string): RosterEntry[] {
  const seen = new Set<string>();
  const list = arr(v).slice(0, MAX_CAST).map((x, i) => {
    const r = obj(x);
    let id = typeof r.id === "string" && r.id ? r.id.slice(0, 16) : `${prefix}${i + 1}`;
    if (seen.has(id)) id = newId();
    seen.add(id);
    return {
      id,
      name: cleanName(r.name, `${prefix === "t" ? "Team" : "Player"} ${i + 1}`),
      members: arr(r.members).map(m => cleanName(m, "")).filter(Boolean).slice(0, MAX_MEMBERS),
    };
  });
  return list.length ? list : fallback;
}

function parseQueue(raw: Raw): { queue: Track[]; trackIdx: number } | null {
  const queue = arr(raw.queue).map(sanitizeTrack).filter(Boolean) as Track[];
  const trackIdx = Math.max(0, int(raw.trackIdx, 0));
  return queue.length && trackIdx < queue.length ? { queue, trackIdx } : null;
}

const sourceOf = (v: unknown) => oneOf(v, ["corpus", "saavn", "catalog"], "catalog");

function parseGame(raw: Raw, mode: Mode, difficulty: Difficulty, mix: Mix): GameState | null {
  const q = parseQueue(raw);
  if (!q) return null;
  const cast: CastMember[] = parseRoster(raw.cast, [], "c").map((c, i) => ({
    ...c, score: Math.max(0, int(obj(arr(raw.cast)[i]).score, 0)), skips: Math.max(0, int(obj(arr(raw.cast)[i]).skips, 0)),
  }));
  if (!cast.length || raw.finished === true) return null;
  const ids = new Set(cast.map(c => c.id));
  const history: HistoryEntry[] = arr(raw.history).map(obj)
    .filter(h => typeof h.id === "string" && ids.has(h.id))
    .map(h => ({ id: h.id as string, song: String(h.song ?? "").slice(0, 120), points: Math.max(0, int(h.points, 0)), round: Math.max(1, int(h.round, 1)) }))
    .slice(-200);
  const round = Math.max(1, int(raw.round, 1));
  return {
    id: isResultId(raw.id) ? raw.id : randomId(),
    ...q,
    turn: Math.min(Math.max(0, int(raw.turn, 0)), cast.length - 1),
    round,
    totalRounds: Math.max(round, int(raw.totalRounds, DEFAULT_ROUNDS)),
    totalSongs: q.queue.length,
    source: sourceOf(raw.source),
    mode: oneOf<Mode>(raw.mode, ["players", "teams"], mode),
    difficulty: oneOf<Difficulty>(raw.difficulty, ["easy", "medium", "hard"], difficulty),
    mix: oneOf<Mix>(raw.mix, ["bolly", "telugu", "both"], mix),
    cast,
    history,
    finished: false,
  };
}

/* v6: { settings:{ mix, sound, snippetLen, eras }, players:[{ name, score }], game:{ queue, trackIdx, turn, round, source } } */
function migrateLegacy(raw: Raw): AppState {
  const set = obj(raw.settings);
  const difficulty: Difficulty = set.sound === "full" ? "easy" : "medium";
  const settings: Settings = { ...parseSettings(set), difficulty, mode: "players" };
  const oldPlayers = arr(raw.players).slice(0, MAX_CAST).map(obj);
  const players = oldPlayers.length
    ? oldPlayers.map((p, i) => ({ id: `p${i + 1}`, name: cleanName(p.name, `Player ${i + 1}`), members: [] }))
    : DEFAULTS.players;
  let game: GameState | null = null;
  const g = obj(raw.game);
  const q = parseQueue(g);
  if (q && oldPlayers.length){
    const cast = players.map((p, i) => ({
      ...p, score: Math.max(0, Math.round((parseFloat(String(oldPlayers[i].score)) || 0) * LEGACY_SCORE_SCALE)), skips: 0,
    }));
    const round = Math.max(1, int(g.round, 1));
    game = {
      id: randomId(),
      ...q,
      turn: Math.min(Math.max(0, int(g.turn, 0)), cast.length - 1),
      round,
      totalRounds: Math.max(round, settings.rounds),
      totalSongs: q.queue.length,
      source: sourceOf(g.source),
      mode: "players",
      difficulty,
      mix: settings.mix,
      cast,
      history: [],
      finished: false,
    };
  }
  return { ...DEFAULTS, settings, players, game };
}

export function loadSaved(): AppState {
  const raw = read(KEY);
  if (!raw){
    const legacy = read(LEGACY_KEY);
    return legacy ? migrateLegacy(obj(legacy)) : DEFAULTS;
  }
  const r = obj(raw);
  const settings = parseSettings(obj(r.settings));
  return {
    screen: "setup",
    settings,
    players: parseRoster(r.players, DEFAULTS.players, "p"),
    teams: parseRoster(r.teams, DEFAULTS.teams, "t"),
    game: parseGame(obj(r.game), settings.mode, settings.difficulty, settings.mix),
  };
}

/* The landing page shows once. Anyone with a save (including players from
   before the landing existed) is a returning visitor. */
export function isFirstVisit(): boolean {
  try { return !localStorage.getItem(LANDING_SEEN_KEY) && read(KEY) === null && read(LEGACY_KEY) === null; } catch { return false; }
}
export function markLandingSeen(){
  try { localStorage.setItem(LANDING_SEEN_KEY, "1"); } catch {}
}

export function save(s: AppState){
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 7, settings: s.settings, players: s.players, teams: s.teams, game: s.game }));
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
}
