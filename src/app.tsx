import { useEffect, useRef, useState } from "react";
import { isFirstVisit, loadSaved, save } from "./lib/save";
import { engine } from "./lib/engine.js";
import { takeInviteFromUrl, useGroup } from "./lib/group";
import { loadHostShow, roomFromUrl, saveHostShow } from "./lib/room";
import { usePassTheGame } from "./game/usePassTheGame";
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
import { GroupScreen } from "./screens/GroupScreen";
import type { AppState, Mode, Play, RosterEntry, Settings } from "./types";

export function App(){
  const [firstVisit] = useState(isFirstVisit);
  const [roomCode, setRoomCode] = useState(roomFromUrl);
  const [invite, setInvite] = useState(takeInviteFromUrl);
  // A group invite link skips the landing page like a room link does, straight to the group screen.
  const [state, setState] = useState<AppState>(() => ({ ...loadSaved(),
    ...(roomCode ? { screen: "buzzer" as const } : invite ? { screen: "group" as const } : firstVisit ? { screen: "landing" as const } : {}) }));
  // Where a phone's "Back to the start" goes: wherever it came from.
  const [buzzerExit, setBuzzerExit] = useState<"landing" | "setup">(firstVisit ? "landing" : "setup");
  const screenNow = useRef(state.screen);
  screenNow.current = state.screen;
  const [hostResume, setHostResume] = useState(false);
  const [hostShow, setHostShow] = useState(loadHostShow);
  const groupSnap = useGroup();
  const game = usePassTheGame(state, setState);

  useEffect(() => { save(state); }, [state]);
  useEffect(() => {
    const onHash = () => {
      const code = roomFromUrl();
      if (code){
        setRoomCode(code);
        const from = screenNow.current;
        if (from === "landing" || from === "setup" || from === "past" || from === "group"){ setBuzzerExit(from === "landing" ? "landing" : "setup"); setState(st => ({ ...st, screen: "buzzer" })); }
        return;
      }
      const i = takeInviteFromUrl(); if (i){ setInvite(i); setState(st => ({ ...st, screen: ["past", "landing", "setup"].includes(st.screen) ? "group" : st.screen })); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const S = state.settings;
  const g = state.game;
  const upSettings = (patch: Partial<Settings>) => setState(st => ({ ...st, settings: { ...st.settings, ...patch } }));
  const setRoster = (mode: Mode, list: RosterEntry[]) => setState(st => (mode === "teams" ? { ...st, teams: list } : { ...st, players: list }));

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
    return <Landing onStart={(play: Play) => setState(st => ({ ...st, screen: "setup", settings: { ...st.settings, play } }))}
      onJoin={() => { setBuzzerExit("landing"); setRoomCode(""); setState(st => ({ ...st, screen: "buzzer" })); }} />;
  }

  let key: string, screen: React.ReactNode, meta = "Now showing";
  if (game.loading){
    key = "loading";
    screen = <Loading settings={S} />;
  } else if (state.screen === "past" && groupSnap.group){
    key = "past"; meta = "Past shows";
    screen = <PastGames group={groupSnap.group} onBack={() => setState(st => ({ ...st, screen: "group" }))} />;
  } else if (state.screen === "group" || state.screen === "past"){
    key = "group"; meta = "Phone group";
    screen = <GroupScreen invite={invite} clearInvite={() => setInvite("")} showPastGames={() => setState(st => ({ ...st, screen: "past" }))}
      onBack={() => { setInvite(""); setState(st => ({ ...st, screen: "setup" })); }} />;
  } else if (state.screen === "setup" || !g){
    key = "setup";
    const saved = g && !g.finished ? g : null;
    screen = <Setup error={game.error} settings={S} upSettings={upSettings} players={state.players} teams={state.teams} setRoster={setRoster}
      blocked={game.blocked} unblockArtist={game.unblockArtist} startGame={() => game.startGame()} savedGame={saved}
      hostShow={hostShow?.started ? hostShow : null}
      openRoom={() => { engine.ac(); saveHostShow(null); setHostShow(null); setHostResume(false); setState(st => ({ ...st, screen: "host" })); }}
      resumeRoom={() => { engine.ac(); setHostResume(true); setState(st => ({ ...st, screen: "host" })); }}
      discardRoom={() => { saveHostShow(null); setHostShow(null); }}
      joinRoom={() => { setBuzzerExit("setup"); setRoomCode(""); setState(st => ({ ...st, screen: "buzzer" })); }}
      resumeGame={game.resumeGame}
      discardGame={() => setState(st => ({ ...st, game: null }))} />;
  } else if (state.screen === "done"){
    key = "done"; meta = "The end";
    screen = <Podium cast={g.cast} onAgain={() => game.startGame(g.cast)} onNewShow={() => setState(st => ({ ...st, screen: "setup", game: null }))} />;
  } else {
    const { phase, turn, verdict, steal, boardRound, who, guesser, track, plain } = game;
    const shownRound = phase === "board" ? boardRound : verdict ? verdict.completedRound : g.round;
    meta = `Round ${Math.min(shownRound, g.totalRounds)} of ${g.totalRounds}`;
    switch (phase){
      case "handover":
        key = `handover-${g.trackIdx}`;
        screen = <Handover game={g} holder={game.holder} onPrime={() => game.primeCurrent()} onHanded={game.handed} />;
        break;
      case "steal":
        key = `steal-${steal}`;
        // A song goes round the table in turn order, so whoever passed it sits just before the stealer.
        screen = <Handover game={g} holder="" steal={{ name: guesser!.name, from: g.cast[(steal! + g.cast.length - 1) % g.cast.length].name, worth: game.stealWorth() }}
          onPrime={() => {}} onHanded={game.stealHanded} />;
        break;
      case "countdown":
        key = "countdown";
        screen = <Countdown skipped={game.skipped} onTick={n => engine.sfx(n > 0 ? "tick" : "roll")} onDone={game.startWhenShown} />;
        break;
      case "reveal":
        key = "reveal";
        screen = <Reveal track={game.revealed ?? track!} name={verdict?.name ?? who!.name} verdict={verdict!} note={game.note}
          onNext={game.passOn} primaryArtist={game.primaryArtist} artistBlocked={game.artistBlocked} onBlockArtist={game.blockArtist} />;
        break;
      case "board":
        key = "board";
        screen = <Scoreboard game={g} round={boardRound} onSettle={() => engine.sfx("flaps")} onNext={game.leaveBoard} />;
        break;
      default:
        key = "playing";
        screen = <Playing name={guesser!.name} track={track!} plain={plain} phase={phase} turn={turn} note={game.note} stealing={steal !== null}
          onPlay={game.playClip} onJudge={game.revealAndScore} onHint={game.hint} onSkip={game.skipSong}
          passTo={game.passTo?.name} onPass={game.passSong}
          skipsLeft={game.skipsLeft} onHeardIt={game.heardIt} />;
    }
  }

  const inGame = state.screen === "game" && !!g && !game.loading;
  return (
    <Stage screenKey={key} meta={meta} game={inGame ? g : null} onHome={game.goHome} onEnd={game.endGame} onShown={key === "playing" ? game.shown : undefined}
      onAbout={key === "setup" ? () => setState(st => ({ ...st, screen: "landing" })) : undefined}
      menu={key === "setup" ? [{ label: "Phone group", onClick: () => setState(st => ({ ...st, screen: "group" })) }] : undefined}>
      {screen}
    </Stage>
  );
}
