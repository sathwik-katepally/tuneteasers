import { useEffect, useState } from "react";
import { AnimatePresence, LazyMotion, MotionConfig } from "motion/react";
import * as m from "motion/react-m";
import { loadSaved, save } from "./lib/save";
import { CLIP_STEPS, DIFFICULTY, hookOffset, pointsNow } from "./lib/config";
import { markPlayed, loadBlocked, saveBlocked, normArtist, isBlocked } from "./lib/storage.js";
import { buildCrate as buildCrateJs } from "./lib/crate.js";
import { engine, keepAwake } from "./lib/engine.js";
import { log } from "./lib/log.js";
import { Theatre } from "./components/Theatre";
import { Setup } from "./screens/Setup";
import { Loading } from "./screens/Loading";
import { Handover } from "./screens/Handover";
import { Countdown } from "./screens/Countdown";
import { Playing } from "./screens/Playing";
import { Guessing } from "./screens/Guessing";
import { Reveal } from "./screens/Reveal";
import { Scoreboard } from "./screens/Scoreboard";
import { Podium } from "./screens/Podium";
import type { AppState, CastMember, Difficulty, GameState, Mode, Phase, RosterEntry, Settings, Track, Turn, Verdict } from "./types";

type Crate = { error?: string; queue?: Track[]; source?: string };
const buildCrate = buildCrateJs as (mix: string, eras: string[], sound: string, difficulty: Difficulty) => Promise<Crate>;

const loadMotion = () => import("./lib/motion-features").then(r => r.default);

const freshTurn = (): Turn => ({ rung: 0, clipEndedAt: null, clipStartedAt: 0, playKey: 0, hint: false, locked: 0 });
const primaryArtistOf = (t: Track | null) => (t ? String(t.artist || "").split(",")[0].trim() : "");

export function App(){
  const [state, setState] = useState<AppState>(loadSaved);
  const [phase, setPhase] = useState<Phase>("handover");
  const [turn, setTurn] = useState<Turn>(freshTurn);
  const [revealed, setRevealed] = useState<Track | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [boardRound, setBoardRound] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [blocked, setBlocked] = useState<string[]>(loadBlocked);

  useEffect(() => { save(state); }, [state]);
  useEffect(() => {
    const on = state.screen === "game";
    keepAwake(on);
    const vis = () => { if (document.visibilityState === "visible") keepAwake(on); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [state.screen]);

  const S = state.settings;
  const g = state.game;
  const track = g ? g.queue[g.trackIdx] ?? null : null;
  const who = g ? g.cast[g.turn] : null;
  const plain = g ? DIFFICULTY[g.difficulty].sound === "full" : false;

  // Warm the next song while this one plays; once a turn is judged the queue
  // has already moved on, so the song at trackIdx is the next one up.
  const upcoming = g && state.screen === "game" ? g.queue[g.trackIdx + (verdict || phase === "board" ? 0 : 1)] : undefined;
  useEffect(() => { if (upcoming) engine.prefetch(upcoming, plain); }, [upcoming?.stream]); // eslint-disable-line react-hooks/exhaustive-deps

  const upSettings = (patch: Partial<Settings>) => setState(st => ({ ...st, settings: { ...st.settings, ...patch } }));
  const setRoster = (mode: Mode, list: RosterEntry[]) => setState(st => (mode === "teams" ? { ...st, teams: list } : { ...st, players: list }));

  function resetTurn(){
    setTurn(freshTurn()); setVerdict(null); setRevealed(null); setNote("");
  }

  async function startGame(cast?: CastMember[]){
    engine.stop();
    setLoading(true); setError("");
    const mode = cast ? g?.mode ?? S.mode : S.mode;
    const roster = cast ?? (mode === "teams" ? state.teams : state.players);
    const crate = await buildCrate(S.mix, S.eras, DIFFICULTY[S.difficulty].sound, S.difficulty);
    setLoading(false);
    if (crate.error || !crate.queue){
      setError(crate.error === "thin"
        ? "Not enough songs match your picks. Try more eras, or unblock a few artists."
        : "Couldn't load songs. Check your connection and try again.");
      setState(st => ({ ...st, screen: "setup" }));
      return;
    }
    const game: GameState = {
      queue: crate.queue, trackIdx: 0, turn: 0, round: 1, totalRounds: S.rounds,
      totalSongs: crate.queue.length, source: crate.source ?? "saavn",
      mode, difficulty: S.difficulty,
      cast: roster.map(r => ({ id: r.id, name: r.name, members: [...r.members], score: 0 })),
      history: [], finished: false,
    };
    resetTurn();
    setPhase("handover");
    setState(st => ({ ...st, screen: "game", game }));
  }

  function primeCurrent(t: Track | null = track){
    engine.prime(t, plain);
    resetTurn();
  }

  async function playClip(rung: number, replay = false){
    if (!track) return;
    engine.ac();
    const secs = CLIP_STEPS[rung];
    setNote("");
    setTurn(t => ({ ...t, rung, clipEndedAt: replay ? t.clipEndedAt : null }));
    const started = () => {
      setTurn(t => ({ ...t, clipStartedAt: Date.now(), playKey: t.playKey + 1 }));
      setPhase("playing");
    };
    const ended = () => {
      setTurn(t => ({ ...t, clipEndedAt: t.clipEndedAt ?? Date.now() }));
      setPhase("listened");
    };
    const failed = () => { setNote("This song won't stream right now. Skip it, or show the answer."); ended(); };
    const cb = { onStart: started, onEnd: ended, onErr: failed, onBlocked: () => setPhase("blocked") };
    log("snippet", { rung, secs, sound: plain ? "full" : "inst", title: String(track.title).slice(0, 28) });
    setPhase("cueing");
    if (plain){
      engine.playElement(track.stream, hookOffset(track), secs, cb);
      return;
    }
    const r = await engine.playSnippet(track, 0, secs, cb);
    if (r === "superseded") return;
    if (r === "snip" || r === "muffle"){ started(); return; }
    setNote("Couldn't take the vocals out of this one, so you'll hear it as it is.");
    if (r === "plain"){ started(); return; }
    log("muffle-fallback", { title: String(track.title).slice(0, 28) });
    engine.playElement(track.stream, 0, secs, cb);
  }

  function knowIt(){
    engine.stop();
    setTurn(t => ({ ...t, locked: pointsNow(t.rung, t.clipEndedAt, t.hint) }));
    setPhase("guessing");
  }

  function showAnswer(){
    if (!track) return;
    setNote("");
    engine.playElement(track.stream, hookOffset(track), 0, { onErr: () => setNote("Couldn't stream the full song.") });
    setRevealed(track);
    setVerdict(null);
    setPhase("reveal");
  }

  function judge(result: "correct" | "wrong"){
    if (!g || !who || !revealed || verdict) return;
    markPlayed(revealed.title);
    const points = result === "correct" ? turn.locked : 0;
    const cast = g.cast.map((c, i) => (i === g.turn ? { ...c, score: c.score + points } : c));
    const trackIdx = g.trackIdx + 1;
    const nextTurn = (g.turn + 1) % cast.length;
    const roundOver = nextTurn === 0;
    const finished = (roundOver && g.round >= g.totalRounds) || trackIdx >= g.queue.length;
    setVerdict({ name: who.name, result, points, total: who.score + points, roundOver: roundOver || finished, finished, completedRound: g.round });
    setBoardRound(g.round);
    if (result === "correct") setTimeout(() => engine.sfx("stamp"), 90);
    else engine.sfx("projector");
    setState(st => ({ ...st, game: {
      ...g, cast, trackIdx, finished,
      turn: finished ? g.turn : nextTurn,
      round: roundOver && !finished ? g.round + 1 : g.round,
      history: [...g.history, { id: who.id, song: revealed.title, points, round: g.round }],
    } }));
  }

  function passOn(){
    engine.stop();
    const toBoard = !!verdict?.roundOver;
    resetTurn();
    setPhase(toBoard ? "board" : "handover");
  }

  function skipSong(){
    if (!g || !track) return;
    engine.stop();
    markPlayed(track.title);
    const trackIdx = g.trackIdx + 1;
    if (trackIdx >= g.queue.length){
      setBoardRound(g.round);
      setState(st => ({ ...st, game: { ...g, trackIdx: g.trackIdx, finished: true } }));
      resetTurn();
      setPhase("board");
      return;
    }
    log("skip", { title: String(track.title).slice(0, 28) });
    primeCurrent(g.queue[trackIdx]);
    setState(st => ({ ...st, game: { ...g, trackIdx } }));
    setPhase("countdown");
  }

  function leaveBoard(){
    if (g?.finished){
      engine.ac();
      engine.sfx("fanfare");
      setState(st => ({ ...st, screen: "done" }));
    } else setPhase("handover");
  }

  function blockArtist(){
    const primary = primaryArtistOf(revealed);
    if (!primary) return;
    const list = loadBlocked();
    const next = list.some((a: string) => normArtist(a) === normArtist(primary)) ? list : [...list, primary];
    saveBlocked(next);
    setBlocked(next);
    const set = new Set(next.map(normArtist));
    const gg = state.game;
    if (!gg) return;
    // Songs already played stay in the queue; only the ones still waiting are dropped.
    const queue = gg.queue.filter((t, i) => i < gg.trackIdx || !isBlocked(t, set));
    const ranOut = gg.trackIdx >= queue.length;
    if (ranOut) setVerdict(v => (v ? { ...v, roundOver: true, finished: true } : v));
    setState(st => ({ ...st, game: { ...gg, queue, totalSongs: queue.length, finished: gg.finished || ranOut } }));
  }
  function unblockArtist(name: string){
    const next = loadBlocked().filter((a: string) => normArtist(a) !== normArtist(name));
    saveBlocked(next);
    setBlocked(next);
  }

  function goHome(){
    log("go-home", {});
    engine.stop();
    resetTurn();
    setPhase("handover");
    setState(st => ({ ...st, screen: "setup", game: st.game?.finished ? null : st.game }));
  }
  function endGame(){
    engine.stop();
    resetTurn();
    setState(st => ({ ...st, screen: "setup", game: null }));
  }

  const holder = who && who.members.length && g ? who.members[(g.round - 1) % who.members.length] : "";
  const primaryArtist = primaryArtistOf(revealed);
  const artistBlocked = !!primaryArtist && blocked.some(a => normArtist(a) === normArtist(primaryArtist));

  let key: string, screen: React.ReactNode, meta = "Now showing";
  if (loading){
    key = "loading";
    screen = <Loading settings={S} />;
  } else if (state.screen === "setup" || !g){
    key = "setup";
    const saved = g && !g.finished ? g : null;
    screen = <Setup error={error} settings={S} upSettings={upSettings} players={state.players} teams={state.teams} setRoster={setRoster}
      blocked={blocked} unblockArtist={unblockArtist} startGame={() => startGame()} savedGame={saved}
      resumeGame={() => { resetTurn(); setPhase("handover"); setState(st => ({ ...st, screen: "game" })); }}
      discardGame={() => setState(st => ({ ...st, game: null }))} />;
  } else if (state.screen === "done"){
    key = "done"; meta = "The end";
    screen = <Podium cast={g.cast} onAgain={() => startGame(g.cast)} onNewShow={() => setState(st => ({ ...st, screen: "setup", game: null }))} />;
  } else {
    const shownRound = phase === "board" ? boardRound : verdict ? verdict.completedRound : g.round;
    meta = `Round ${Math.min(shownRound, g.totalRounds)} of ${g.totalRounds}`;
    switch (phase){
      case "handover":
        key = `handover-${g.trackIdx}`;
        screen = <Handover game={g} holder={holder} onPrime={() => primeCurrent()} onHanded={() => setPhase("countdown")} />;
        break;
      case "countdown":
        key = "countdown";
        screen = <Countdown onTick={n => engine.sfx(n > 0 ? "tick" : "roll")} onDone={() => playClip(0)} />;
        break;
      case "guessing":
        key = "guessing";
        screen = <Guessing name={who!.name} turn={turn} onShow={showAnswer} />;
        break;
      case "reveal":
        key = "reveal";
        screen = <Reveal track={revealed ?? track!} name={verdict?.name ?? who!.name} verdict={verdict} worth={turn.locked} note={note}
          onJudge={judge} onNext={passOn} primaryArtist={primaryArtist} artistBlocked={artistBlocked} onBlockArtist={blockArtist} />;
        break;
      case "board":
        key = "board";
        screen = <Scoreboard game={g} round={boardRound} onSettle={() => engine.sfx("flaps")} onNext={leaveBoard} />;
        break;
      default:
        key = "playing";
        screen = <Playing name={who!.name} track={track!} phase={phase} turn={turn} note={note}
          onPlay={playClip} onKnow={knowIt} onHint={() => setTurn(t => ({ ...t, hint: true }))} onSkip={skipSong} />;
    }
  }

  const inGame = state.screen === "game" && !!g && !loading;
  return (
    <LazyMotion features={loadMotion} strict>
      <MotionConfig reducedMotion="user">
        <Theatre meta={meta} game={inGame ? g : null} onHome={goHome} onEnd={endGame}>
          <AnimatePresence mode="wait" initial={false}>
            <m.div key={key} className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
              {screen}
            </m.div>
          </AnimatePresence>
        </Theatre>
      </MotionConfig>
    </LazyMotion>
  );
}
