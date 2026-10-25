import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { DIFFICULTY, LADDER, hookOffset, pointsNow } from "../lib/config";
import { useClipPlayer } from "../lib/ladder";
import { cooldownOf, loadHistory, markPlayed, loadBlocked, saveBlocked, normArtist, isBlocked } from "../lib/storage";
import { buildCrate, orderForCast, refreshMusicQueue, withLangAt } from "../lib/crate";
import { langLabel } from "../lib/languages";
import { engine, keepAwake } from "../lib/engine.js";
import { log } from "../lib/log.js";
import { displayTitle } from "../lib/utils.js";
import { groupCooldown, randomId, recordPlay, recordResult, useGroup } from "../lib/group";
import type { AppState, CastMember, GameState, Lang, Phase, Track, Verdict } from "../types";

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
  // The title of a song just skipped, shown on the next countdown.
  const [skipped, setSkipped] = useState("");
  const [blocked, setBlocked] = useState<string[]>(loadBlocked);
  const groupSnap = useGroup();
  const startOnShow = useRef(0);
  // Read by timers: a countdown that ends after Home was tapped must not start a clip.
  const screenNow = useRef(state.screen);
  screenNow.current = state.screen;

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
    // A contestant's language counts only while it is one of the show's.
    const roster = (cast ?? (mode === "teams" ? state.teams : state.players))
      .map(r => ({ ...r, lang: r.lang && S.langs.includes(r.lang) ? r.lang : undefined }));
    const need: Partial<Record<Lang, number>> = {};
    for (const r of roster) if (r.lang) need[r.lang] = (need[r.lang] || 0) + S.rounds;
    const cooldown = (groupSnap.group ? await groupCooldown() : null) ?? cooldownOf(loadHistory());
    const crate = await buildCrate({ langs: S.langs, eras: S.eras, sound: DIFFICULTY[S.difficulty].sound, songs: S.songs,
      minSongs: S.rounds * roster.length, need, cooldown, categories: S.categories });
    setLoading(false);
    if ("error" in crate){
      const who = crate.lang ? roster.filter(r => r.lang === crate.lang).map(r => r.name).join(" and ") : "";
      setError(crate.error === "safe" ? "Not enough verified music-only clips for this show. Try With singing or fewer rounds, or widen your song picks."
        : crate.error === "thin" && crate.lang
        ? `Not enough ${langLabel(crate.lang)} songs for ${who}. Try more eras${S.categories.length ? ", another kind of song" : ""}, or Mix for ${who}.`
        : crate.error === "thin"
        ? `Not enough songs match your picks. Try more eras${S.categories.length ? ", another kind of song" : ""}, or unblock a few artists.`
        : "Couldn't load songs. Check your connection and try again.");
      setState(st => ({ ...st, screen: "setup" }));
      return;
    }
    const castNow: CastMember[] = roster.map(r => ({ id: r.id, name: r.name, members: [...r.members], ...(r.lang ? { lang: r.lang } : {}), score: 0 }));
    const queue = orderForCast(crate.queue, castNow, S.rounds * castNow.length);
    const game: GameState = {
      id: randomId(),
      queue, trackIdx: 0, turn: 0, round: 1, totalRounds: S.rounds,
      totalSongs: queue.length, source: crate.source,
      mode, difficulty: S.difficulty, langs: S.langs,
      cast: castNow,
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
      setState(st => ({ ...st, screen:"game", game:{ ...g, queue: withLangAt(queue, 0, g.cast[g.turn]?.lang), trackIdx:0, totalSongs:queue.length } }));
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
    if (screenNow.current !== "game") return;
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
    const points = result === "correct" ? pointsNow(LADDER, turn.rung, turn.clipEndedAt, turn.hints, Date.now(), steal !== null) : 0;
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
      queue: finished ? g.queue : withLangAt(g.queue, trackIdx, cast[nextTurn].lang),
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
  const stealWorth = () => pointsNow(LADDER, turn.rung, Date.now(), turn.hints, Date.now(), true);

  function passOn(){
    engine.stop();
    const toBoard = !!verdict?.roundOver;
    resetTurn();
    setPhase(toBoard ? "board" : "handover");
  }

  /* Skip: free and unlimited, for any reason (heard it to death, a dead
     stream). The same contestant gets the next queued song, the title goes up
     on the countdown so the room sees what was skipped, and nothing is
     recorded: a skipped song was not heard through, so it stays in play. */
  function skipSong(){
    if (!g || !track || verdict) return;
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
    const queue = withLangAt(g.queue, trackIdx, who?.lang);
    primeCurrent(queue[trackIdx]);
    setSkipped(displayTitle(track.title));
    setState(st => ({ ...st, game: { ...g, queue, trackIdx } }));
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
    // The next turn's song may be the one that goes, so its contestant's language is put back first.
    const queue = withLangAt(gg.queue.filter((t, i) => i < gg.trackIdx || !isBlocked(t, set)), gg.trackIdx, gg.cast[gg.turn]?.lang);
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

  return {
    phase, turn, revealed, verdict, steal, boardRound, note, skipped, loading, error, blocked,
    track, who, guesser, passTo, plain, holder, primaryArtist, artistBlocked,
    startGame, resumeGame, primeCurrent, handed: () => setPhase("countdown"), startWhenShown, shown,
    playClip, hint: () => setTurn(t => ({ ...t, hints: t.hints + 1 })), revealAndScore,
    passSong, stealHanded, stealWorth, passOn, skipSong,
    leaveBoard, blockArtist, unblockArtist, goHome, endGame,
  };
}
