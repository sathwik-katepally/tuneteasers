import { useEffect, useRef, useState } from "react";
import { DIFFICULTY, LADDER, ROOM_ANSWER_SECS, ROOM_AUTO_SECS, ROOM_DEAD_CLIP_MS, ROOM_DEAD_CLIP_SKIPS, ROOM_FILM_SHARE, ROOM_GRACE_SECS, ROOM_SONGS_PER_ROUND, ROOM_WRONG_BEAT_MS, hookOffset } from "../lib/config";
import { nearTitles } from "../lib/answer.js";
import { useClipPlayer } from "../lib/ladder";
import { answerTitles, buildCrate, halfAnswer, withFreshAt, type AnswerEntry } from "../lib/crate";
import { isFilmLang } from "../lib/languages";
import { engine, keepAwake } from "../lib/engine.js";
import { cooldownOf, loadHistory, markPlayed, type Cooldown } from "../lib/storage";
import { displayTitle } from "../lib/utils.js";
import { log } from "../lib/log.js";
import { groupCooldown, recordPlay } from "../lib/group";
import { createRoom, loadHostShow, playerName, saveHostShow, useMsLeft, useRoom, withRoomHeard, type HostShow, type RoomView } from "../lib/room";
import { Stage } from "../components/Stage";
import { Countdown } from "../screens/Countdown";
import { Loading } from "../screens/Loading";
import { Reveal } from "../screens/Reveal";
import { Scoreboard } from "../screens/Scoreboard";
import { Podium } from "../screens/Podium";
import { JoinTag, Lobby, RoomTrouble } from "./Lobby";
import { HostPlaying, type Audio } from "./HostPlaying";
import type { GameState, Lang, Settings, Track, Verdict } from "../types";

type Phase = "opening" | "lobby" | "loading" | "countdown" | "song" | "reveal" | "board" | "done" | "failed";
interface Revealed { track: Track; verdict: Verdict }

/* Refusals that leave the show stuck get a note on the big screen. A late
   skip or a clip beaten by a buzz does not: the show carries on by itself. */
const STUCK = new Set(["bad-song-number", "bad-song", "not-started", "already-started", "no-players"]);

/* The host screen of a buzz-in room: the only device that plays audio. It
   runs the show (songs, clip ladder, reveals, box office) and tells the room
   what is playing; the room referees buzzes and answers (worker/src/room.js). */
export function Host({ settings, resume, onExit }: { settings: Settings; resume: boolean; onExit: (keep: boolean) => void }){
  const [show, setShowState] = useState<HostShow | null>(() => (resume ? loadHostShow() : null));
  const [phase, setPhase] = useState<Phase>(resume ? "lobby" : "opening");
  const [error, setError] = useState("");
  const [audio, setAudio] = useState<Audio>("cueing");
  const [graceUntil, setGraceUntil] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [wrong, setWrong] = useState<{ name: string; text: string; timeout: boolean; at: number } | null>(null);
  const [skipped, setSkipped] = useState("");
  const [dead, setDead] = useState(false);
  // First clips in a row that never started: past the limit the host waits for a tap, or a dead CDN would run through the queue.
  const deadRun = useRef(0);
  // What this screen has decided and the room may not have heard yet; the sync below delivers it.
  const [gaveUp, setGaveUp] = useState(false);
  const [skipCue, setSkipCue] = useState(0);

  const setShow = (s: HostShow | null) => { setShowState(s); saveHostShow(s); };
  const room = useRoom(show?.code ?? "", show ? { t: "host", token: show.host } : null);
  const view = room.view;
  const msLeft = useMsLeft(view);
  const track = show ? show.queue[show.idx] ?? null : null;
  const plain = show?.plain ?? DIFFICULTY[settings.difficulty].sound === "full";
  const ladder = LADDER;
  const player = useClipPlayer({ track, plain,
    setStatus: s => setAudio(a => (s === "playing" && a === "blocked" ? a : s)),
    // A stream the engine gave up on can still start late; a song that plays is not skipped.
    onStarted: () => { deadRun.current = 0; setDead(false); },
    onEnded: () => setGraceUntil(Date.now() + ROOM_GRACE_SECS * 1000),
    onFailed: rung => { if (rung === 0 && deadRun.current++ < ROOM_DEAD_CLIP_SKIPS) setDead(true); },
  });
  const { turn: clip, note, setNote } = player;

  /* The room's song while it is this track's cue. Its number alone does not
     say so: after a skip this screen made by itself the room still holds the
     song before under the same number, and a view never carries a title
     before the reveal. Cue ids only grow, so a cue above the one the room
     showed when this track's `song` went out is this track's. */
  const cued = useRef<{ track: Track; after: number } | null>(null);
  const song = view?.song && show && track && view.song.n === show.songNo + 1 && cued.current?.track === track && view.song.cue > cued.current.after ? view.song : null;

  // Timers and socket callbacks read the latest values through these.
  const live = useRef({ view, song, show, clip, phase, track, audio, heard: room.heard });
  live.current = { view, song, show, clip, phase, track, audio, heard: room.heard };
  /* This screen's history (and its group's, at the start of a show) with
     every seated phone's: those songs sit out. A phone that sat down after
     the crate was built is caught when the next song is picked. */
  const own = useRef<Cooldown | null>(null);
  const cooldownNow = () => withRoomHeard(own.current ?? cooldownOf(loadHistory()), live.current.heard).cooldown;
  const freshCue = (s: HostShow): HostShow => ({ ...s, queue: withFreshAt(s.queue, s.idx, cooldownNow()) });

  useEffect(() => {
    if (phase !== "opening") return;
    let on = true;
    createRoom().then(({ code, host }) => {
      if (!on) return;
      setShow({ code, host, queue: [], idx: 0, songNo: 0, total: settings.rounds * ROOM_SONGS_PER_ROUND, perRound: ROOM_SONGS_PER_ROUND,
        plain: DIFFICULTY[settings.difficulty].sound === "full", difficulty: settings.difficulty, langs: settings.langs, songs: settings.songs, eras: settings.eras, categories: settings.categories, started: false, skipsSeen: 0 });
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

  /* A resumed show trusts the room, not this screen's saved counters: songs
     the room finished while the screen was away (someone answered during a
     reload) count as played, a finished song comes back on its reveal so the
     show carries on from there, and a show that has used up its songs goes to
     the box office. Only an unfinished song starts over. */
  const resumed = useRef(!resume);
  useEffect(() => {
    if (resumed.current || !view || !show) return;
    resumed.current = true;
    if (view.phase === "over"){ setPhase("done"); return; }
    if (view.phase !== "show" || !show.started) return;
    const done = view.results.length;
    const s = { ...show, songNo: done, idx: Math.max(0, show.idx + done - show.songNo) };
    setShow(s);
    const last = view.song;
    const lastTrack = s.queue[s.idx - 1];
    if (done > 0 && last?.n === done && last.state === "revealed" && lastTrack){
      if (done > show.songNo){ markPlayed(lastTrack.title); recordPlay(lastTrack.title); }
      showReveal(view, lastTrack, s);
      return;
    }
    if (done >= s.total || s.idx >= s.queue.length){ setPhase("board"); return; }
    setPhase("countdown");
  }, [view, show]); // eslint-disable-line react-hooks/exhaustive-deps

  // The public title list, for the near-miss titles sent with each song.
  const pool = useRef<{ key: string; titles: Promise<AnswerEntry[]> } | null>(null);
  const titlePool = (langs: Lang[]) => {
    const key = langs.join(",");
    if (pool.current?.key !== key) pool.current = { key, titles: answerTitles(langs).catch(() => []) };
    return pool.current.titles;
  };

  useEffect(() => { if (room.gone) setPhase(p => (p === "done" ? p : "failed")); }, [room.gone]);

  useEffect(() => {
    if (!room.error) return;
    log("room-refused", { code: room.error.code, phase });
    if (!STUCK.has(room.error.code)) return;
    setNote(`The room didn't accept that (${room.error.code}). Go Home from the menu and resume the show.`);
  }, [room.error?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const upcoming = show?.queue[show.idx + (phase === "reveal" ? 0 : 1)];
    if (upcoming) engine.prefetch(upcoming, plain);
  }, [show?.idx, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* auto: the lobby's countdown ran out, so there is no tap to unlock audio in. */
  async function startShow(auto = false){
    if (!show) return;
    engine.ac();
    if (!auto) engine.unlock();
    setPhase("loading");
    setError("");
    own.current = (await groupCooldown()) ?? cooldownOf(loadHistory());
    const { cooldown, heardBy } = withRoomHeard(own.current, live.current.heard);
    const crate = await buildCrate({ langs: show.langs, eras: show.eras, sound: show.plain ? "full" : "inst", songs: show.songs,
      minSongs: show.total, cooldown, categories: show.categories, heardBy });
    if ("error" in crate){
      setError(crate.error === "safe" ? "Not enough verified music-only clips for this show. Go back and pick With singing or fewer rounds."
        : crate.error === "thin" ? `Not enough songs match your picks. Go back and pick more eras${show.categories.length ? " or another kind of song" : ""}.`
        : "Couldn't load songs. Check the connection and try again.");
      setPhase("lobby");
      return;
    }
    const queue = crate.queue;
    await titlePool(show.langs);
    // A phone that sat down while the crate loaded is only in the latest heard.
    const next = freshCue({ ...show, queue, idx: 0, songNo: 0, started: true, skipsSeen: 0 });
    setShow(next);
    // No prime here: the crate took the tap's gesture with it, and a prime
    // outside a gesture only races the first clip. A strict browser shows
    // "Tap to play" for the first song instead.
    toCountdown();
  }

  function toCountdown(skippedTitle = ""){
    setSkipped(skippedTitle);
    player.reset();
    setAudio("cueing");
    setGraceUntil(null);
    setRevealed(null);
    setWrong(null);
    setGaveUp(false);
    setPhase("countdown");
  }

  /* A replay starts from the top of the clip window; otherwise the rung plays
     only its new stretch, carrying on from where the last one stopped. */
  function playClip(rung: number, replay = false){
    if (!live.current.track) return;
    setGaveUp(false);
    setDead(false);
    setGraceUntil(null);
    setPhase("song");
    void player.play(rung, replay);
  }

  /* Nobody has it yet: the next rung for everyone, or the reveal once the
     ladder is spent or every player is locked out. A buzz that cut a clip
     short means the room missed part of it, so the next play starts from the
     top of the window (the last rung just replays). */
  function carryOn(){
    const { view: v, song: s, clip: c, phase: p, audio: a } = live.current;
    if (p !== "song" || !v || !s) return;
    // A tap already started the next rung while the miss beat or the grace window was still running.
    if (a === "cueing" || a === "playing") return;
    if (s.state !== "live" && s.state !== "missed") return;
    const everyoneOut = v.players.length > 0 && v.players.every(pl => s.locked.includes(pl.id));
    if (everyoneOut) return giveUp();
    if (c.rung < ladder.last) return void playClip(c.rung + 1, c.cut);
    if (c.cut) return void playClip(c.rung, true);
    giveUp();
  }
  /* The host's own tap: the next rung, or the whole window again on the last one. */
  function more(){
    const c = live.current.clip;
    if (c.rung < ladder.last) playClip(c.rung + 1, c.cut);
    else playClip(c.rung, true);
  }
  function giveUp(){
    engine.stop();
    setGaveUp(true);
  }

  /* Everything this screen tells the room about the show goes out here. The
     room reports its state as whole views, but `send` drops a message while
     the link is down, so one sent at the moment something happened could be
     lost for good. Each view is instead compared with what this screen knows,
     and the first thing the room is missing is sent. Only what the view shows
     as missing: the room takes a second `start` as an error, a second `song`
     as a new cue (the buzzes are gone) and a second `clip` as buzzing open
     again after a miss. */
  // A view from before a link gap says nothing about what the room got since; every reopen brings a new one.
  const stale = useRef<RoomView | null>(null);
  // The last message and the room state it answered: until the view moves on, that answer is already on its way.
  const sent = useRef("");
  if (room.link !== "open"){ stale.current = view; sent.current = ""; }
  useEffect(() => {
    if (room.link !== "open" || !view || view === stale.current || !show) return;
    const r = view.song;
    const at = [view.phase, r?.n, r?.cue, r?.state, r?.rung, r?.queue.length, r?.guesses.length].join();
    const say = (m: { t: string; [k: string]: unknown }) => {
      if (sent.current === m.t + at || !room.send(m)) return false;
      sent.current = m.t + at;
      return true;
    };
    if (phase === "board" || phase === "done"){
      if (view.phase === "show" && (show.songNo >= show.total || show.idx >= show.queue.length)) say({ t: "end" });
      return;
    }
    if ((phase !== "countdown" && phase !== "song") || !show.started || !track) return;
    // No titles go to the room here: phones load the public list themselves.
    if (view.phase !== "show") return void say({ t: "start", langs: show.langs, total: show.total, perRound: show.perRound, answerSecs: ROOM_ANSWER_SECS, filmShare: ROOM_FILM_SHARE });
    if (!song){
      // The room hears about a song from its countdown on; buzzing stays shut until its first clip is actually playing.
      const after = r?.cue ?? 0;
      titlePool(show.langs).then(titles => {
        if (live.current.track !== track || live.current.view !== view || view === stale.current) return;
        const film = halfAnswer(track);
        if (say({ t: "song", n: show.songNo + 1, title: track.title, film, half: isFilmLang(track.lang) ? "film" : "artist", year: track.year || 0, artist: track.artist || "",
          near: nearTitles(track.title, film, titles) })) cued.current = { track, after };
      });
      return;
    }
    // While someone answers the room refuses both; the view after the answer brings the sync back.
    const takes = song.state === "cue" || song.state === "live" || song.state === "missed";
    if (gaveUp){ if (takes) say({ t: "reveal" }); return; }
    // A clip has started and no buzz has paused it, so the room should be live on its rung.
    const heard = audio === "playing" || (audio === "listened" && graceUntil !== null);
    if (heard && takes && (song.state !== "live" || song.rung !== clip.rung)) say({ t: "clip", rung: clip.rung, points: ladder.points[clip.rung] });
    else if (skipCue === song.cue && song.state === "live" && !song.queue.length && !song.guesses.length) say({ t: "skip", cue: song.cue });
  }, [view, room.link, phase, track, show?.started, audio, graceUntil, clip.rung, gaveUp, skipCue]); // eslint-disable-line react-hooks/exhaustive-deps

  // React to the referee. Every buzz sits in the queue until it is judged,
  // then moves to guesses, so their sum only ever grows by one per buzz.
  const seen = useRef({ n: 0, buzzes: 0, guesses: 0 });
  useEffect(() => {
    const s = view?.song;
    if (s) log("room-song", { n: s.n, state: s.state, rung: s.rung, phase, songNo: show?.songNo ?? -1 });
    if (!s || !show || s !== song || (phase !== "song" && phase !== "countdown")) return;
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
        player.setTurn(c => ({ ...c, rung: a === "cueing" ? Math.max(0, s.rung) : c.rung, cut: true }));
        setAudio("paused");
      }
    } else if (s.state === "revealed" && phase === "song") toReveal(view!);
  }, [view?.seq, view?.song?.state, view?.song?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // A miss gets a beat on screen, then the show carries on. Not while the
  // link is down: the room would never hear of the clip or the reveal.
  useEffect(() => {
    if (phase !== "song" || song?.state !== "missed" || room.link !== "open") return;
    const id = window.setTimeout(carryOn, ROOM_WRONG_BEAT_MS);
    return () => window.clearTimeout(id);
  }, [phase, song?.state, view?.seq, room.link]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once a clip ends, buzzing stays open for a few seconds before the next rung (held, too, while the link is down).
  useEffect(() => {
    if (phase !== "song" || graceUntil === null || song?.state !== "live" || room.link !== "open") return;
    const id = window.setTimeout(carryOn, Math.max(0, graceUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [phase, graceUntil, song?.state, room.link]); // eslint-disable-line react-hooks/exhaustive-deps

  function toReveal(v: RoomView){
    const t = live.current.track;
    if (!show || !t) return;
    markPlayed(t.title);
    recordPlay(t.title);
    const next = { ...show, idx: show.idx + 1, songNo: show.songNo + 1 };
    setShow(next);
    showReveal(v, t, next);
  }

  /* The reveal of the room's latest song; `s` already counts it as played. */
  function showReveal(v: RoomView, t: Track, s: HostShow){
    const song = v.song!;
    engine.stop();
    engine.playElement(t.stream, hookOffset(t), 0, { onErr: () => setNote("Couldn't stream the full song.") });
    const finished = s.songNo >= s.total || s.idx >= s.queue.length;
    const winner = v.players.find(p => p.id === song.winner);
    setRevealed({ track: t, verdict: {
      name: winner ? (song.guesses.some(g => g.id === winner.id && g.ok && g.film) ? `${winner.name} (the ${isFilmLang(t.lang) ? "film" : "artist"})` : winner.name) : "anyone", result: winner ? "correct" : "wrong", points: song.won, total: winner?.score ?? 0,
      roundOver: finished || s.songNo % s.perRound === 0, finished, completedRound: Math.ceil(s.songNo / s.perRound),
    } });
    if (winner) setTimeout(() => engine.sfx("stamp"), 90);
    else engine.sfx("projector");
    setPhase("reveal");
  }

  /* auto: the reveal's countdown moved on, not a tap. A prime only works
     inside a tap; without one the next song plays from an element the
     engine unlocked at an earlier tap (engine.unlock). */
  function afterReveal(auto = false){
    if (!show || !revealed) return;
    engine.stop();
    if (revealed.verdict.roundOver){ setPhase("board"); return; }
    const s = freshCue(show);
    setShow(s);
    if (!auto) engine.prime(s.queue[s.idx], s.plain);
    toCountdown();
  }

  /* After a stream error: the room never heard of this cue, so song n is
     cued again with the next track without asking it. */
  function skipSong(){
    if (!show || !track) return;
    engine.stop();
    nextTrack(show, displayTitle(track.title));
  }
  function nextTrack(s: HostShow, skippedTitle = ""){
    const next = freshCue({ ...s, idx: s.idx + 1 });
    setShow(next);
    if (next.idx >= next.queue.length){
      setPhase("board");
      return;
    }
    engine.prime(next.queue[next.idx], next.plain);
    toCountdown(skippedTitle);
  }

  /* A first clip that never started leaves the song in `cue`: nobody heard
     it and no phone can vote to skip it, so after a beat to read the note
     the host skips it by itself. Not while the link is down: an offline host
     fails every stream, and the skips would run through the whole queue. */
  useEffect(() => {
    if (!dead || phase !== "song" || room.link !== "open") return;
    const id = window.setTimeout(skipSong, ROOM_DEAD_CLIP_MS);
    return () => window.clearTimeout(id);
  }, [dead, phase, room.link]); // eslint-disable-line react-hooks/exhaustive-deps

  /* A skip decided by the room (every phone voted, or the host's own tap):
     song n is cued again with the next track, and nothing is recorded.
     Acting on the room's skip count, not the tap, makes each skip happen
     exactly once, through a reload too. */
  useEffect(() => {
    const { view: v, show: sh, track: t } = live.current;
    if (!v || !sh?.started || !t || (phase !== "song" && phase !== "countdown")) return;
    if (v.skips <= sh.skipsSeen || v.song?.state !== "skipped" || v.song.n !== sh.songNo + 1) return;
    engine.stop();
    log("skip", { room: true, title: String(t.title).slice(0, 28) });
    nextTrack({ ...sh, skipsSeen: v.skips }, displayTitle(t.title));
  }, [view?.skips, view?.song?.state, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  function leaveBoard(auto = false){
    if (!show) return;
    if (view?.phase === "over" || show.songNo >= show.total || show.idx >= show.queue.length){
      engine.ac();
      engine.sfx("fanfare");
      setPhase("done");
      return;
    }
    const s = freshCue(show);
    setShow(s);
    if (!auto) engine.prime(s.queue[s.idx], s.plain);
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
      screen = <Countdown skipped={skipped} onTick={n => engine.sfx(n > 0 ? "tick" : "roll")} onDone={() => playClip(0)} />;
      break;
    case "reveal":
      screen = revealed && <Reveal track={revealed.track} name={revealed.verdict.name} verdict={revealed.verdict} note={note}
        onNext={afterReveal} autoSecs={ROOM_AUTO_SECS.reveal} nextLabel={revealed.verdict.finished ? "Final box office" : revealed.verdict.roundOver ? "To the box office" : "Next song"}
        primaryArtist="" artistBlocked={false} onBlockArtist={() => {}} />;
      break;
    case "board":
      key = `board-${show?.songNo}`;
      screen = game && <Scoreboard game={game} round={Math.max(1, Math.ceil((show?.songNo ?? 1) / (show?.perRound ?? 1)))} onSettle={() => engine.sfx("flaps")} onNext={leaveBoard} autoSecs={ROOM_AUTO_SECS.board} />;
      break;
    case "done":
      meta = "The end";
      screen = game && <Podium cast={game.cast} onAgain={() => { if (show) setShow({ ...show, started: false }); void startShow(); }} onNewShow={endShow} />;
      break;
    default:
      key = `song-${show?.idx}`;
      screen = view && show && track && (
        <HostPlaying view={view} song={song} songNo={show.songNo + 1} total={show.total} ladder={ladder} clip={clip} audio={audio}
          graceUntil={graceUntil} msLeft={msLeft} note={note} wrong={wrong} link={room.link}
          onPlay={() => playClip(clip.rung, true)} onMore={more} onReveal={giveUp} onSkip={skipSong}
          onRoomSkip={setSkipCue} />
      );
  }
  const inShow = !!show?.started && phase !== "lobby" && phase !== "failed" && phase !== "opening";
  // Latecomers can still take a seat, so the code and QR stay up beside the show on a big screen.
  const tag = code && inShow && phase !== "done" ? <JoinTag code={code} /> : null;
  return (
    <Stage screenKey={key} meta={meta} game={inShow ? game : null} onHome={() => { engine.stop(); onExit(true); }} onEnd={endShow}
      wide={phase === "lobby"} aside={tag}>
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
    mode: "players", difficulty: show.difficulty, langs: show.langs,
    cast: view.players.map(p => ({ id: p.id, name: p.name, members: [], score: p.score })),
    history: view.results.map(r => ({ id: r.winner ?? "", song: displayTitle(r.title), points: r.points, round: round(r.n) })),
    finished: view.phase === "over",
  };
}
