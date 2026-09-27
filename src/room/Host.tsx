import { useEffect, useRef, useState } from "react";
import { CLIP_POINTS, CLIP_STEPS, DIFFICULTY, MUSIC_CLIP_STEPS, ROOM_ANSWER_SECS, ROOM_DECOYS_PER_SONG, ROOM_GRACE_SECS,
  ROOM_SONGS_PER_ROUND, ROOM_SPARE_SONGS, ROOM_WRONG_BEAT_MS, hookOffset } from "../lib/config";
import { buildCrate as buildCrateJs, decoyTitles as decoyTitlesJs } from "../lib/crate.js";
import { engine, keepAwake } from "../lib/engine.js";
import { markPlayed } from "../lib/storage.js";
import { displayTitle, shuffle } from "../lib/utils.js";
import { log } from "../lib/log.js";
import { groupPlayed, recordPlay } from "../lib/group";
import { createRoom, loadHostShow, playerName, saveHostShow, useMsLeft, useRoom, type HostShow, type RoomView } from "../lib/room";
import { Stage } from "../components/Stage";
import { Countdown } from "../screens/Countdown";
import { Loading } from "../screens/Loading";
import { Reveal } from "../screens/Reveal";
import { Scoreboard } from "../screens/Scoreboard";
import { Podium } from "../screens/Podium";
import { Lobby, RoomTrouble } from "./Lobby";
import { HostPlaying, type Audio } from "./HostPlaying";
import type { Difficulty, GameState, Settings, Track, Verdict } from "../types";

type Crate = { error?: string; queue?: Track[] };
const buildCrate = buildCrateJs as (mix: string, eras: string[], sound: string, difficulty: Difficulty, minSongs: number, played?: Record<string, number>) => Promise<Crate>;
const decoyTitles = decoyTitlesJs as (mix: string, eras: string[], n: number, exclude: string[]) => Promise<string[]>;

type Phase = "opening" | "lobby" | "loading" | "countdown" | "song" | "reveal" | "board" | "done" | "failed";
interface Clip { rung: number; startedAt: number; endedAt: number | null; key: number; cut: boolean }
interface Revealed { track: Track; verdict: Verdict }

const freshClip = (): Clip => ({ rung: 0, startedAt: 0, endedAt: null, key: 0, cut: false });

/* The host screen of a buzz-in room: the only device that plays audio. It
   runs the show (songs, clip ladder, reveals, box office) and tells the room
   what is playing; the room referees buzzes and answers (worker/src/room.js). */
export function Host({ settings, resume, onExit }: { settings: Settings; resume: boolean; onExit: (keep: boolean) => void }){
  const [show, setShowState] = useState<HostShow | null>(() => (resume ? loadHostShow() : null));
  const [phase, setPhase] = useState<Phase>(resume ? "lobby" : "opening");
  const [error, setError] = useState("");
  const [audio, setAudio] = useState<Audio>("cueing");
  const [clip, setClip] = useState<Clip>(freshClip);
  const [graceUntil, setGraceUntil] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [wrong, setWrong] = useState<{ name: string; text: string; timeout: boolean; at: number } | null>(null);

  const setShow = (s: HostShow | null) => { setShowState(s); saveHostShow(s); };
  const room = useRoom(show?.code ?? "", show ? { t: "host", token: show.host } : null);
  const view = room.view;
  const msLeft = useMsLeft(view);
  const track = show ? show.queue[show.idx] ?? null : null;
  const plain = show?.plain ?? DIFFICULTY[settings.difficulty].sound === "full";
  const steps = plain ? CLIP_STEPS : MUSIC_CLIP_STEPS;

  // Timers and socket callbacks read the latest values through these.
  const live = useRef({ view, show, clip, phase, track, audio });
  live.current = { view, show, clip, phase, track, audio };

  useEffect(() => {
    if (phase !== "opening") return;
    let on = true;
    createRoom().then(({ code, host }) => {
      if (!on) return;
      setShow({ code, host, queue: [], idx: 0, songNo: 0, total: settings.rounds * ROOM_SONGS_PER_ROUND, perRound: ROOM_SONGS_PER_ROUND,
        plain: DIFFICULTY[settings.difficulty].sound === "full", difficulty: settings.difficulty, mix: settings.mix, eras: settings.eras, started: false });
      setPhase("lobby");
    }, e => { if (on){ log("room-create-fail", { msg: String(e?.message || e).slice(0, 60) }); setPhase("failed"); } });
    return () => { on = false; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    keepAwake(true);
    const vis = () => { if (document.visibilityState === "visible") keepAwake(true); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); keepAwake(false); engine.stop(); };
  }, []);

  // A resumed show picks up where the room is: still in the lobby, mid-show
  // (the interrupted song starts over), or finished.
  const resumed = useRef(!resume);
  useEffect(() => {
    if (resumed.current || !view || !show) return;
    resumed.current = true;
    if (view.phase === "over") setPhase("done");
    else if (view.phase === "show" && show.started) setPhase(show.idx >= show.queue.length ? "done" : "countdown");
  }, [view, show]);

  useEffect(() => { if (room.gone) setPhase(p => (p === "done" ? p : "failed")); }, [room.gone]);

  useEffect(() => {
    const upcoming = show?.queue[show.idx + (phase === "reveal" ? 0 : 1)];
    if (upcoming) engine.prefetch(upcoming, plain);
  }, [show?.idx, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startShow(){
    if (!show) return;
    engine.ac();
    setPhase("loading");
    setError("");
    const played = await groupPlayed();
    const crate = await buildCrate(show.mix, show.eras, show.plain ? "full" : "inst", show.difficulty, show.total, played ?? undefined);
    if (crate.error || !crate.queue){
      setError(crate.error === "safe" ? "Not enough verified music-only clips for this show. Go back and pick Easy or fewer rounds."
        : crate.error === "thin" ? "Not enough songs match your picks. Go back and pick more eras."
        : "Couldn't load songs. Check the connection and try again.");
      setPhase("lobby");
      return;
    }
    const queue = crate.queue;
    const inShow = queue.slice(0, show.total + ROOM_SPARE_SONGS).map(t => displayTitle(t.title));
    const decoys = await decoyTitles(show.mix, show.eras, show.total * ROOM_DECOYS_PER_SONG, queue.map(t => t.title));
    const titles = shuffle([...new Set([...inShow, ...decoys])]);
    room.send({ t: "start", titles, total: show.total, perRound: show.perRound, answerSecs: ROOM_ANSWER_SECS });
    const next = { ...show, queue, idx: 0, songNo: 0, started: true };
    setShow(next);
    engine.prime(queue[0], show.plain);
    toCountdown();
  }

  function toCountdown(){
    setClip(freshClip());
    setAudio("cueing");
    setGraceUntil(null);
    setNote("");
    setRevealed(null);
    setWrong(null);
    setPhase("countdown");
  }

  // The room hears about a song when its countdown starts, so buzzing stays
  // shut until the first clip is actually playing.
  useEffect(() => {
    if (phase !== "countdown" || !show || !track) return;
    room.send({ t: "song", n: show.songNo + 1, title: track.title, film: track.album || "", year: track.year || 0, artist: track.artist || "" });
  }, [phase, room.link]); // eslint-disable-line react-hooks/exhaustive-deps

  async function playClip(rung: number, again = false){
    const t = live.current.track;
    if (!t) return;
    engine.ac();
    const secs = steps[rung];
    setNote("");
    setGraceUntil(null);
    setPhase("song");
    setClip(c => ({ ...c, rung, endedAt: again ? c.endedAt : null, cut: false }));
    const started = () => {
      setClip(c => ({ ...c, startedAt: Date.now(), key: c.key + 1 }));
      setAudio(a => (a === "blocked" ? a : "playing"));
      room.send({ t: "clip", rung, points: CLIP_POINTS[rung] });
    };
    const ended = () => {
      setClip(c => ({ ...c, endedAt: Date.now() }));
      setAudio("listened");
      setGraceUntil(Date.now() + ROOM_GRACE_SECS * 1000);
    };
    const failed = () => {
      setNote(plain ? "This song won't stream right now. Skip it to try another." : "This music-only clip isn't available. Skip it to try another.");
      setAudio("listened");
    };
    const cb = { onStart: started, onEnd: ended, onErr: failed, onBlocked: () => setAudio("blocked") };
    log("snippet", { rung, secs, sound: plain ? "full" : "inst", room: true });
    setAudio("cueing");
    if (plain){ engine.playElement(t.stream, hookOffset(t), secs, cb); return; }
    const r = await engine.playSnippet(t, 0, secs, cb);
    if (r === "superseded") return;
    if (r === "snip"){ started(); return; }
    failed();
  }

  /* Nobody has it yet: the next rung for everyone, the same rung again if a
     buzz cut the last one short, or the reveal once the ladder is spent or
     every player is locked out. */
  function carryOn(){
    const { view: v, clip: c, phase: p } = live.current;
    if (p !== "song" || !v?.song) return;
    const s = v.song;
    if (s.state !== "live" && s.state !== "missed") return;
    const everyoneOut = v.players.length > 0 && v.players.every(pl => s.locked.includes(pl.id));
    if (everyoneOut) return giveUp();
    if (c.rung < steps.length - 1) return void playClip(c.rung + 1);
    if (c.cut) return void playClip(c.rung, true);
    giveUp();
  }
  function giveUp(){
    engine.stop();
    room.send({ t: "reveal" });
  }

  // React to the referee. Every buzz sits in the queue until it is judged,
  // then moves to guesses, so their sum only ever grows by one per buzz.
  const seen = useRef({ n: 0, buzzes: 0, guesses: 0 });
  useEffect(() => {
    const s = view?.song;
    if (s) log("room-song", { n: s.n, state: s.state, rung: s.rung, phase, songNo: show?.songNo ?? -1 });
    if (!s || !show || s.n !== show.songNo + 1 || (phase !== "song" && phase !== "countdown")) return;
    const last = seen.current.n === s.n ? seen.current : { n: s.n, buzzes: 0, guesses: 0 };
    const buzzes = s.queue.length + s.guesses.length;
    if (buzzes > last.buzzes) engine.sfx("buzz");
    const g = s.guesses[s.guesses.length - 1];
    if (s.guesses.length > last.guesses && !g.ok){
      setTimeout(() => engine.sfx("nope"), buzzes > last.buzzes ? 450 : 0);
      setWrong({ name: playerName(view, g.id), text: g.text, timeout: g.timeout, at: Date.now() });
    }
    seen.current = { n: s.n, buzzes, guesses: s.guesses.length };

    if (s.state === "answering"){
      setGraceUntil(null);
      const a = live.current.audio;
      if (a === "playing" || a === "cueing"){
        engine.stop();
        // A buzz that beat the next rung to the speakers is on the rung the room last opened.
        setClip(c => ({ ...c, rung: a === "cueing" ? Math.max(0, s.rung) : c.rung, cut: true }));
        setAudio("paused");
      }
    } else if (s.state === "revealed" && phase === "song") toReveal(view!);
  }, [view?.seq, view?.song?.state, view?.song?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // A miss gets a beat on screen, then the show carries on.
  useEffect(() => {
    if (phase !== "song" || view?.song?.state !== "missed") return;
    const id = window.setTimeout(carryOn, ROOM_WRONG_BEAT_MS);
    return () => window.clearTimeout(id);
  }, [phase, view?.song?.state, view?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once a clip ends, buzzing stays open for a few seconds before the next rung.
  useEffect(() => {
    if (phase !== "song" || graceUntil === null || view?.song?.state !== "live") return;
    const id = window.setTimeout(carryOn, Math.max(0, graceUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [phase, graceUntil, view?.song?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  function toReveal(v: RoomView){
    const s = v.song!;
    const t = live.current.track;
    if (!show || !t) return;
    engine.stop();
    engine.playElement(t.stream, hookOffset(t), 0, { onErr: () => setNote("Couldn't stream the full song.") });
    markPlayed(t.title);
    recordPlay(t.title);
    const songNo = show.songNo + 1;
    const idx = show.idx + 1;
    const finished = songNo >= show.total || idx >= show.queue.length;
    const winner = v.players.find(p => p.id === s.winner);
    setRevealed({ track: t, verdict: {
      name: winner ? winner.name : "anyone", result: winner ? "correct" : "wrong", points: s.won, total: winner?.score ?? 0,
      roundOver: finished || songNo % show.perRound === 0, finished, completedRound: Math.ceil(songNo / show.perRound),
    } });
    if (winner) setTimeout(() => engine.sfx("stamp"), 90);
    else engine.sfx("projector");
    setShow({ ...show, idx, songNo });
    setPhase("reveal");
  }

  function afterReveal(){
    if (!show || !revealed) return;
    engine.stop();
    if (revealed.verdict.finished) room.send({ t: "end" });
    if (revealed.verdict.roundOver){ setPhase("board"); return; }
    engine.prime(show.queue[show.idx], show.plain);
    toCountdown();
  }

  function skipSong(){
    if (!show || !track) return;
    engine.stop();
    markPlayed(track.title);
    recordPlay(track.title);
    const idx = show.idx + 1;
    setShow({ ...show, idx });
    if (idx >= show.queue.length){
      room.send({ t: "end" });
      setPhase("board");
      return;
    }
    engine.prime(show.queue[idx], show.plain);
    toCountdown();
  }

  function leaveBoard(){
    if (!show) return;
    if (view?.phase === "over" || show.songNo >= show.total || show.idx >= show.queue.length){
      engine.ac();
      engine.sfx("fanfare");
      setPhase("done");
      return;
    }
    engine.prime(show.queue[show.idx], show.plain);
    toCountdown();
  }

  function endShow(){
    engine.stop();
    room.send({ t: "end" });
    setShow(null);
    onExit(false);
  }

  const game = asGame(view, show);
  const code = show?.code ?? "";
  // The song count is on the stage itself; the marquee keeps the code in view for latecomers.
  let key: string = phase, screen: React.ReactNode, meta = code ? `Room ${code}` : "Buzz-in show";
  switch (phase){
    case "opening":
      screen = <Loading settings={settings} />;
      break;
    case "failed":
      screen = <RoomTrouble gone={!!room.gone} onBack={() => { setShow(null); onExit(false); }} onRetry={() => { setShow(null); setPhase("opening"); }} />;
      break;
    case "lobby":
      screen = <Lobby code={code} view={view} link={room.link} settings={settings} error={error}
        onStart={startShow} onKick={id => room.send({ t: "kick", id })} onBack={() => { setShow(null); onExit(false); }} />;
      break;
    case "loading":
      screen = <Loading settings={settings} />;
      break;
    case "countdown":
      // Same key as the song screen: a buzz can land within the cross-fade,
      // and two key changes inside one fade leave AnimatePresence stuck on the old screen.
      key = `song-${show?.idx}`;
      screen = <Countdown onTick={n => engine.sfx(n > 0 ? "tick" : "roll")} onDone={() => playClip(0)} />;
      break;
    case "reveal":
      screen = revealed && <Reveal track={revealed.track} name={revealed.verdict.name} verdict={revealed.verdict} note={note}
        onNext={afterReveal} nextLabel={revealed.verdict.finished ? "Final box office" : revealed.verdict.roundOver ? "To the box office" : "Next song"}
        primaryArtist="" artistBlocked={false} onBlockArtist={() => {}} />;
      break;
    case "board":
      key = `board-${show?.songNo}`;
      screen = game && <Scoreboard game={game} round={Math.max(1, Math.ceil((show?.songNo ?? 1) / (show?.perRound ?? 1)))} onSettle={() => engine.sfx("flaps")} onNext={leaveBoard} />;
      break;
    case "done":
      meta = "The end";
      screen = game && <Podium cast={game.cast} onAgain={() => { if (show) setShow({ ...show, started: false }); startShow(); }} onNewShow={endShow} />;
      break;
    default:
      key = `song-${show?.idx}`;
      screen = view && show && track && (
        <HostPlaying view={view} song={view.song?.n === show.songNo + 1 ? view.song : null} songNo={show.songNo + 1} total={show.total} steps={steps} clip={clip} audio={audio}
          graceUntil={graceUntil} msLeft={msLeft} note={note} wrong={wrong} link={room.link}
          onPlay={() => playClip(clip.rung, true)} onMore={carryOn} onReveal={giveUp} onSkip={skipSong} />
      );
  }
  const inShow = !!show?.started && phase !== "lobby" && phase !== "failed" && phase !== "opening";
  return (
    <Stage screenKey={key} meta={meta} game={inShow ? game : null} onHome={() => { engine.stop(); onExit(true); }} onEnd={endShow}>
      {screen}
    </Stage>
  );
}

/* The room's players and results in the shape the box office and podium read. */
function asGame(view: RoomView | null, show: HostShow | null): GameState | null {
  if (!view || !show) return null;
  const round = (n: number) => Math.ceil(n / show.perRound);
  return {
    id: view.code, queue: [], trackIdx: show.idx, turn: 0, round: round(Math.max(1, show.songNo)),
    totalRounds: Math.ceil(show.total / show.perRound), totalSongs: show.total, source: "room",
    mode: "players", difficulty: show.difficulty, mix: show.mix,
    cast: view.players.map(p => ({ id: p.id, name: p.name, members: [], score: p.score })),
    history: view.results.map(r => ({ id: r.winner ?? "", song: displayTitle(r.title), points: r.points, round: round(r.n) })),
    finished: view.phase === "over",
  };
}
