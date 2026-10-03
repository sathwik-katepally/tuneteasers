import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DIFFICULTY, SKIPS_PER_PLAYER, hookOffset, ladderFor, pointsNow } from "../lib/config";
import { useClipPlayer } from "../lib/ladder";
import { cooldownOf, loadHistory, markPlayed, loadBlocked, saveBlocked, normArtist, isBlocked, type Cooldown } from "../lib/storage";
import { buildCrate, refreshMusicQueue, withSameTierNext } from "../lib/crate";
import { engine, keepAwake } from "../lib/engine.js";
import { log } from "../lib/log.js";
import { displayTitle } from "../lib/utils.js";
import { groupCooldown, randomId, recordPlay, recordResult, useGroup } from "../lib/group";
import type { AppState, CastMember, GameState, Phase, Track, Verdict } from "../types";

const primaryArtistOf = (t: Track | null) => (t ? String(t.artist || "").split(",")[0].trim() : "");

/* The pass-the-phone turn engine: the per-turn state that is deliberately not
   saved (phase, the clip, the revealed track, verdict, steal) and every handler
   the game screens call. The saved game stays in App's `state`; judging a turn
   updates it in one step, so a reload can never award the same turn twice. */
export function usePassTheGame(state: AppState, setState: Dispatch<SetStateAction<AppState>>){
  const [phase, setPhase] = useState<Phase>("handover");
  const [revealed, setRevealed] = useState<Track | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  // The cast index a passed song is with, or null while it is with the contestant whose turn it is.
  const [steal, setSteal] = useState<number | null>(null);
  const [boardRound, setBoardRound] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // The title of a song just skipped as heard too much, shown on the next countdown.
  const [skipped, setSkipped] = useState("");
  const [blocked, setBlocked] = useState<string[]>(loadBlocked);
  const groupSnap = useGroup();
  const startOnShow = useRef(0);
  /* The cooldown the show's crate was built with (this phone's history, with the
     group's when there is one), so a "Heard it too much" replacement prefers a
     song nobody is sick of; a resumed show reads this phone's again. */
  const own = useRef<Cooldown | null>(null);
  const cooldownNow = () => (own.current ??= cooldownOf(loadHistory()));

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
  const guesser = g ? g.cast[steal ?? g.turn] : null;
  // Round the table once: the song never comes back to the contestant whose turn it is.
  const passIdx = g ? ((steal ?? g.turn) + 1) % g.cast.length : 0;
  const passTo = g && passIdx !== g.turn ? g.cast[passIdx] : null;
  const plain = g ? DIFFICULTY[g.difficulty].sound === "full" : false;
  const player = useClipPlayer({ track, plain,
    // A refused play() reports back before playing starts; keep the tap prompt.
    setStatus: s => setPhase(p => (s === "playing" && (p === "blocked" || p === "listened") ? p : s)),
  });
  const { turn, setTurn, note, setNote, play: playClip } = player;

  // A finished show goes to the group once; the id makes a resend harmless.
  useEffect(() => { if (g?.finished) recordResult(g); }, [g?.id, g?.finished]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warm the next song while this one plays; once a turn is judged the queue
  // has already moved on, so the song at trackIdx is the next one up.
  const upcoming = g && state.screen === "game" ? g.queue[g.trackIdx + (verdict || phase === "board" ? 0 : 1)] : undefined;
  useEffect(() => { if (upcoming) engine.prefetch(upcoming, plain); }, [upcoming?.stream]); // eslint-disable-line react-hooks/exhaustive-deps

  function resetTurn(){
    clearTimeout(startOnShow.current); startOnShow.current = 0;
    player.reset(); setVerdict(null); setRevealed(null); setSkipped(""); setSteal(null);
  }

  async function startGame(cast?: CastMember[]){
    engine.stop();
    setLoading(true); setError("");
    const mode = cast ? g?.mode ?? S.mode : S.mode;
    const roster = cast ?? (mode === "teams" ? state.teams : state.players);
    own.current = (groupSnap.group ? await groupCooldown() : null) ?? cooldownOf(loadHistory());
    const crate = await buildCrate(S.mix, S.eras, DIFFICULTY[S.difficulty].sound, S.difficulty, S.rounds * roster.length, own.current, S.categories);
    setLoading(false);
    if ("error" in crate){
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
      totalSongs: crate.queue.length, source: crate.source,
      mode, difficulty: S.difficulty, mix: S.mix,
      cast: roster.map(r => ({ id: r.id, name: r.name, members: [...r.members], score: 0, skips: 0 })),
      history: [], finished: false,
    };
    resetTurn();
    setPhase("handover");
    setState(st => ({ ...st, screen: "game", game }));
  }

  async function resumeGame(){
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
  }

  function primeCurrent(t: Track | null = track){
    engine.prime(t, plain);
    resetTurn();
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
    if (!g || !who || !guesser || !track || verdict || phase === "reveal") return;
    const points = result === "correct" ? pointsNow(ladderFor(plain), turn.rung, turn.clipEndedAt, turn.hints, Date.now(), steal !== null) : 0;
    const scorer = result === "correct" ? guesser : who;
    engine.stop();
    setNote("");
    engine.playElement(track.stream, hookOffset(track), 0, { onErr: () => setNote("Couldn't stream the full song.") });
    setRevealed(track);
    setPhase("reveal");
    markPlayed(track.title);
    recordPlay(track.title);
    const cast = g.cast.map(c => (c.id === scorer.id ? { ...c, score: c.score + points } : c));
    const trackIdx = g.trackIdx + 1;
    const nextTurn = (g.turn + 1) % cast.length;
    const roundOver = nextTurn === 0;
    const finished = (roundOver && g.round >= g.totalRounds) || trackIdx >= g.queue.length;
    const name = result === "wrong" && steal !== null ? "anyone" : scorer.name;
    setVerdict({ name, result, points, total: scorer.score + points, roundOver: roundOver || finished, finished, completedRound: g.round });
    setBoardRound(g.round);
    if (result === "correct") setTimeout(() => engine.sfx("stamp"), 90);
    else engine.sfx("projector");
    setState(st => ({ ...st, game: {
      ...g, cast, trackIdx, finished,
      turn: finished ? g.turn : nextTurn,
      round: roundOver && !finished ? g.round + 1 : g.round,
      history: [...g.history, { id: scorer.id, song: displayTitle(track.title), points, round: g.round }],
    } }));
  }

  /* The song stays the same and so does the clip heard so far; the phone goes
     to the next contestant, who can replay it or hear more. */
  function passSong(){
    if (!g || !passTo || verdict) return;
    engine.stop();
    log("pass", { to: passIdx });
    setNote("");
    setSteal(passIdx);
    setPhase("steal");
  }
  function stealHanded(){
    // The speed bonus starts fading from when the stealer has the phone, not from when the clip ended.
    setTurn(t => ({ ...t, clipEndedAt: Date.now() }));
    setPhase("listened");
  }
  const stealWorth = () => pointsNow(ladderFor(plain), turn.rung, Date.now(), turn.hints, Date.now(), true);

  function passOn(){
    engine.stop();
    const toBoard = !!verdict?.roundOver;
    resetTurn();
    setPhase(toBoard ? "board" : "handover");
  }

  /* After a stream error: free, and the song goes on no cooldown, since it
     was never heard and may stream fine next time. */
  function skipSong(){
    if (!g || !track) return;
    engine.stop();
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

  /* "Heard it too much": costs the contestant one of their skips, sits the
     song out for the longer tired cooldown, and brings a song from the same
     tier. The title goes up on screen so the room sees what was skipped. */
  const heardItQueue = g && who && who.skips < SKIPS_PER_PLAYER ? withSameTierNext(g.queue, g.trackIdx, cooldownNow()) : null;
  function heardIt(){
    if (!g || !who || !track || !heardItQueue || verdict) return;
    engine.stop();
    markPlayed(track.title, "tired");
    recordPlay(track.title, "tired");
    log("skip", { tired: true, title: String(track.title).slice(0, 28) });
    const trackIdx = g.trackIdx + 1;
    primeCurrent(heardItQueue[trackIdx]);
    setSkipped(displayTitle(track.title));
    setState(st => ({ ...st, game: { ...g, queue: heardItQueue, trackIdx, cast: g.cast.map((c, i) => (i === g.turn ? { ...c, skips: c.skips + 1 } : c)) } }));
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
    const next = list.some(a => normArtist(a) === normArtist(primary)) ? list : [...list, primary];
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
    const next = loadBlocked().filter(a => normArtist(a) !== normArtist(name));
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
  const skipsLeft = who ? Math.max(0, SKIPS_PER_PLAYER - who.skips) : 0;

  return {
    phase, turn, revealed, verdict, steal, boardRound, note, skipped, loading, error, blocked,
    track, who, guesser, passTo, plain, holder, primaryArtist, artistBlocked, skipsLeft,
    startGame, resumeGame, primeCurrent, handed: () => setPhase("countdown"), startWhenShown, shown,
    playClip, hint: () => setTurn(t => ({ ...t, hints: t.hints + 1 })), revealAndScore,
    passSong, stealHanded, stealWorth, passOn, skipSong, heardIt: heardItQueue ? heardIt : undefined,
    leaveBoard, blockArtist, unblockArtist, goHome, endGame,
  };
}
