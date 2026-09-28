import { useEffect, useRef, useState } from "react";
import { isFirstVisit, loadSaved, save } from "./lib/save";
import { DIFFICULTY, hookOffset, ladderFor, pointsNow } from "./lib/config";
import { playRung } from "./lib/ladder";
import { markPlayed, loadBlocked, saveBlocked, normArtist, isBlocked } from "./lib/storage.js";
import { buildCrate as buildCrateJs, refreshMusicQueue as refreshMusicQueueJs } from "./lib/crate.js";
import { engine, keepAwake } from "./lib/engine.js";
import { log } from "./lib/log.js";
import { displayTitle } from "./lib/utils.js";
import { randomId, recordResult, takeInviteFromUrl, useGroup } from "./lib/group";
import { presentCooldown, recordPlays, refreshMe, syncBlocked, syncFilters, takeTicketFromUrl, useMe, type Prefs } from "./lib/me";
import { loadHostShow, roomFromUrl, saveHostShow } from "./lib/room";
import { Stage } from "./components/Stage";
import { Host } from "./room/Host";
import { Phone } from "./room/Phone";
import { Setup } from "./screens/Setup";
import { Loading } from "./screens/Loading";
import { Handover } from "./screens/Handover";
import { Countdown } from "./screens/Countdown";
import { Playing } from "./screens/Playing";
import { Reveal } from "./screens/Reveal";
import { Scoreboard } from "./screens/Scoreboard";
import { Podium } from "./screens/Podium";
import { Landing } from "./screens/Landing";
import { PastGames } from "./screens/PastGames";
import type { AppState, CastMember, Category, Difficulty, GameState, Mode, Phase, RosterEntry, Settings, Track, Turn, Verdict } from "./types";

type Crate = { error?: string; queue?: Track[]; source?: string };
const buildCrate = buildCrateJs as (mix: string, eras: string[], sound: string, difficulty: Difficulty, minSongs: number, until?: Record<string, number>, categories?: Category[], heardBy?: Record<string, number>) => Promise<Crate>;
const refreshMusicQueue = refreshMusicQueueJs as (queue: Track[]) => Promise<Track[]>;

const freshTurn = (): Turn => ({ rung: 0, span: { from: 0, to: 0 }, clipEndedAt: null, clipStartedAt: 0, playKey: 0, hint: false });
const primaryArtistOf = (t: Track | null) => (t ? String(t.artist || "").split(",")[0].trim() : "");
/* Every ticket in a roster or cast: the people whose histories the show follows. */
const peopleOf = (list: RosterEntry[]) => [...new Set(list.flatMap(r => r.people ?? []))];

export function App(){
  const [firstVisit] = useState(isFirstVisit);
  const [roomCode, setRoomCode] = useState(roomFromUrl);
  // A group invite link skips the landing page like a room link does.
  const [state, setState] = useState<AppState>(() => ({ ...loadSaved(),
    ...(roomCode ? { screen: "buzzer" as const } : firstVisit && !location.hash.startsWith("#join=") ? { screen: "landing" as const } : {}) }));
  // Where a phone's "Back to the start" goes: wherever it came from.
  const [buzzerExit, setBuzzerExit] = useState<"landing" | "setup">(firstVisit ? "landing" : "setup");
  const screenNow = useRef(state.screen);
  screenNow.current = state.screen;
  const [hostResume, setHostResume] = useState(false);
  const [hostShow, setHostShow] = useState(loadHostShow);
  const [phase, setPhase] = useState<Phase>("handover");
  const [turn, setTurn] = useState<Turn>(freshTurn);
  const [revealed, setRevealed] = useState<Track | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [boardRound, setBoardRound] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [blocked, setBlocked] = useState<string[]>(loadBlocked);
  const [invite, setInvite] = useState(takeInviteFromUrl);
  const [moveTicket, setMoveTicket] = useState(takeTicketFromUrl);
  const groupSnap = useGroup();
  const meSnap = useMe();
  const startOnShow = useRef(0);

  useEffect(() => { save(state); }, [state]);
  useEffect(() => {
    const onHash = () => {
      const code = roomFromUrl();
      if (code){
        setRoomCode(code);
        const from = screenNow.current;
        if (from === "landing" || from === "setup" || from === "past"){ setBuzzerExit(from === "landing" ? "landing" : "setup"); setState(st => ({ ...st, screen: "buzzer" })); }
        return;
      }
      const i = takeInviteFromUrl(); if (i){ setInvite(i); setState(st => ({ ...st, screen: st.screen === "past" || st.screen === "landing" ? "setup" : st.screen })); }
      const t = takeTicketFromUrl(); if (t){ setMoveTicket(t); setState(st => ({ ...st, screen: st.screen === "past" || st.screen === "landing" ? "setup" : st.screen })); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
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

  // A finished show goes to the group once; the id makes a resend harmless.
  useEffect(() => { if (g?.finished) recordResult(g); }, [g?.id, g?.finished]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warm the next song while this one plays; once a turn is judged the queue
  // has already moved on, so the song at trackIdx is the next one up.
  const upcoming = g && state.screen === "game" ? g.queue[g.trackIdx + (verdict || phase === "board" ? 0 : 1)] : undefined;
  useEffect(() => { if (upcoming) engine.prefetch(upcoming, plain); }, [upcoming?.stream]); // eslint-disable-line react-hooks/exhaustive-deps

  // A ticket's preferences land here: the blocked list on this phone, its default filters in the settings.
  const tookPrefs = (prefs: Prefs | null) => {
    if (!prefs) return;
    setBlocked(loadBlocked());
    if (prefs.filters) setState(st => ({ ...st, settings: { ...st.settings, ...prefs.filters } }));
  };
  useEffect(() => { refreshMe().then(tookPrefs); }, [meSnap.me?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const upSettings = (patch: Partial<Settings>) => setState(st => {
    const settings = { ...st.settings, ...patch };
    if ("mix" in patch || "eras" in patch || "difficulty" in patch || "categories" in patch) syncFilters(settings);
    return { ...st, settings };
  });
  const setRoster = (mode: Mode, list: RosterEntry[]) => setState(st => (mode === "teams" ? { ...st, teams: list } : { ...st, players: list }));

  function resetTurn(){
    clearTimeout(startOnShow.current); startOnShow.current = 0;
    setTurn(freshTurn()); setVerdict(null); setRevealed(null); setNote("");
  }

  async function startGame(cast?: CastMember[]){
    engine.stop();
    setLoading(true); setError("");
    const mode = cast ? g?.mode ?? S.mode : S.mode;
    const roster = cast ?? (mode === "teams" ? state.teams : state.players);
    const { until, heardBy } = await presentCooldown(peopleOf(roster));
    const crate = await buildCrate(S.mix, S.eras, DIFFICULTY[S.difficulty].sound, S.difficulty, S.rounds * roster.length, until, S.categories, heardBy);
    setLoading(false);
    if (crate.error || !crate.queue){
      setError(crate.error === "safe" ? "Not enough verified music-only clips for this show. Try Easy or fewer rounds, or widen your song picks."
        : crate.error === "thin"
        ? `Not enough songs match your picks. Try more eras${S.categories.length ? ", another kind of song" : ""}, or unblock a few artists.`
        : "Couldn't load songs. Check your connection and try again.");
      setState(st => ({ ...st, screen: "setup" }));
      return;
    }
    const game: GameState = {
      id: randomId(),
      queue: crate.queue, trackIdx: 0, turn: 0, round: 1, totalRounds: S.rounds,
      totalSongs: crate.queue.length, source: crate.source ?? "corpus",
      mode, difficulty: S.difficulty, mix: S.mix,
      cast: roster.map(r => ({ id: r.id, name: r.name, members: [...r.members], ...(r.people?.length ? { people: [...r.people] } : {}), score: 0 })),
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
    const span = ladderFor(plain).span(rung, replay);
    setNote("");
    setTurn(t => ({ ...t, rung, span, clipEndedAt: replay ? t.clipEndedAt : null }));
    const started = () => {
      setTurn(t => ({ ...t, clipStartedAt: Date.now(), playKey: t.playKey + 1 }));
      // A refused play() reports back before playing starts; keep the tap prompt.
      setPhase(p => (p === "blocked" || p === "listened" ? p : "playing"));
    };
    const ended = () => {
      setTurn(t => ({ ...t, clipEndedAt: t.clipEndedAt ?? Date.now() }));
      setPhase("listened");
    };
    const failed = () => {
      setNote(plain ? "This song won't stream right now. Skip it to try another." : "This music-only clip isn't available. Skip it to try another.");
      ended();
    };
    log("snippet", { rung, from: span.from, to: span.to, sound: plain ? "full" : "inst", title: String(track.title).slice(0, 28) });
    setPhase("cueing");
    const r = await playRung(track, plain, rung, replay, { onStart: started, onEnd: ended, onErr: failed, onBlocked: () => setPhase("blocked") });
    if (r === "failed") failed();
  }

  /* The countdown hands over silently: the first clip starts only once the
     listening screen has faded in, so the sound, "Now playing" and the clip
     bar start together. The timeout covers a fade that never reports back
     (a hidden tab pauses animation frames). */
  function startWhenShown(){
    setPhase("cueing");
    startOnShow.current = window.setTimeout(shown, 1500);
  }
  function shown(){
    if (!startOnShow.current) return;
    clearTimeout(startOnShow.current); startOnShow.current = 0;
    playClip(0);
  }

  function revealAndScore(result: "correct" | "wrong"){
    if (!g || !who || !track || verdict || phase === "reveal") return;
    const points = result === "correct" ? pointsNow(ladderFor(plain), turn.rung, turn.clipEndedAt, turn.hint) : 0;
    engine.stop();
    setNote("");
    engine.playElement(track.stream, hookOffset(track), 0, { onErr: () => setNote("Couldn't stream the full song.") });
    setRevealed(track);
    setPhase("reveal");
    markPlayed(track.title);
    recordPlays(track.title, "played", peopleOf(g.cast));
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
      history: [...g.history, { id: who.id, song: displayTitle(track.title), points, round: g.round }],
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
    recordPlays(track.title, "played", peopleOf(g.cast));
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
    syncBlocked(next);
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
    syncBlocked(next);
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

  if (state.screen === "host"){
    return <Host settings={S} resume={hostResume} onExit={keep => {
      setHostShow(keep ? loadHostShow() : null);
      if (!keep) saveHostShow(null);
      setHostResume(false);
      setState(st => ({ ...st, screen: "setup" }));
    }} />;
  }
  if (state.screen === "buzzer"){
    return <Phone code={roomCode} onExit={() => { setRoomCode(""); setState(st => ({ ...st, screen: buzzerExit })); }} />;
  }
  if (state.screen === "landing"){
    return <Landing onStart={() => setState(st => ({ ...st, screen: "setup" }))}
      onJoin={() => { setBuzzerExit("landing"); setRoomCode(""); setState(st => ({ ...st, screen: "buzzer" })); }} />;
  }

  let key: string, screen: React.ReactNode, meta = "Now showing";
  if (loading){
    key = "loading";
    screen = <Loading settings={S} />;
  } else if (state.screen === "past" && groupSnap.group){
    key = "past"; meta = "Past shows";
    screen = <PastGames group={groupSnap.group} onBack={() => setState(st => ({ ...st, screen: "setup" }))} />;
  } else if (state.screen === "setup" || state.screen === "past" || !g){
    key = "setup";
    const saved = g && !g.finished ? g : null;
    screen = <Setup error={error} settings={S} upSettings={upSettings} players={state.players} teams={state.teams} setRoster={setRoster}
      blocked={blocked} unblockArtist={unblockArtist} startGame={() => startGame()} savedGame={saved}
      invite={invite} clearInvite={() => setInvite("")} showPastGames={() => setState(st => ({ ...st, screen: "past" }))}
      moveTicket={moveTicket} clearMoveTicket={() => setMoveTicket("")} onTicketPrefs={tookPrefs} people={groupSnap.people} me={meSnap.me}
      hostShow={hostShow?.started ? hostShow : null}
      openRoom={() => { engine.ac(); saveHostShow(null); setHostShow(null); setHostResume(false); setState(st => ({ ...st, screen: "host" })); }}
      resumeRoom={() => { engine.ac(); setHostResume(true); setState(st => ({ ...st, screen: "host" })); }}
      discardRoom={() => { saveHostShow(null); setHostShow(null); }}
      joinRoom={() => { setBuzzerExit("setup"); setRoomCode(""); setState(st => ({ ...st, screen: "buzzer" })); }}
      resumeGame={async () => {
        if (!g) return;
        if (DIFFICULTY[g.difficulty].sound === "inst"){
          setLoading(true);
          const queue = await refreshMusicQueue(g.queue.slice(g.trackIdx));
          setLoading(false);
          if (queue.length < (g.totalRounds - g.round) * g.cast.length + (g.cast.length - g.turn)){
            setError("Not enough verified music-only clips remain to resume. Start a new show with Easy or fewer rounds.");
            return;
          }
          setState(st => ({ ...st, screen:"game", game:{ ...g, queue, trackIdx:0, totalSongs:queue.length } }));
        } else setState(st => ({ ...st, screen:"game" }));
        resetTurn(); setPhase("handover");
      }}
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
        screen = <Countdown onTick={n => engine.sfx(n > 0 ? "tick" : "roll")} onDone={startWhenShown} />;
        break;
      case "reveal":
        key = "reveal";
        screen = <Reveal track={revealed ?? track!} name={verdict?.name ?? who!.name} verdict={verdict!} note={note}
          onNext={passOn} primaryArtist={primaryArtist} artistBlocked={artistBlocked} onBlockArtist={blockArtist} />;
        break;
      case "board":
        key = "board";
        screen = <Scoreboard game={g} round={boardRound} onSettle={() => engine.sfx("flaps")} onNext={leaveBoard} />;
        break;
      default:
        key = "playing";
        screen = <Playing name={who!.name} track={track!} plain={plain} phase={phase} turn={turn} note={note}
          onPlay={playClip} onJudge={revealAndScore} onHint={() => setTurn(t => ({ ...t, hint: true }))} onSkip={skipSong} />;
    }
  }

  const inGame = state.screen === "game" && !!g && !loading;
  return (
    <Stage screenKey={key} meta={meta} game={inGame ? g : null} onHome={goHome} onEnd={endGame} onShown={key === "playing" ? shown : undefined}
      onAbout={key === "setup" ? () => setState(st => ({ ...st, screen: "landing" })) : undefined}>
      {screen}
    </Stage>
  );
}
