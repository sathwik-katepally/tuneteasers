import { useState, useEffect } from "preact/hooks";
import { ERAS } from "./lib/constants.js";
import { loadPersisted, persist, markPlayed, loadBlocked, saveBlocked, normArtist, isBlocked } from "./lib/storage.js";
import { buildCrate } from "./lib/crate.js";
import { engine, keepAwake } from "./lib/engine.js";
import { Setup, Loading } from "./screens/Setup.jsx";
import { Game } from "./screens/Game.jsx";
import { Done } from "./screens/Done.jsx";

export function App(){
  const [state, setState] = useState(loadPersisted);
  const [phase, setPhase] = useState("ready");        // ready | cueing | playing | guessing | revealed
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [showBoard, setShowBoard] = useState(false);
  const [snip, setSnip] = useState({ end:0, lastSecs:10, playSecs:0 });
  const [blocked, setBlocked] = useState(loadBlocked);
  const [hint, setHint] = useState(false);

  useEffect(()=>{ persist(state); }, [state]);
  useEffect(()=>{
    keepAwake(state.screen === "game");
    const vis = ()=>{ if (document.visibilityState==="visible") keepAwake(state.screen==="game"); };
    document.addEventListener("visibilitychange", vis);
    return ()=>document.removeEventListener("visibilitychange", vis);
  }, [state.screen]);

  const S = state.settings;
  const g = state.game;
  const track = g ? g.queue[g.trackIdx] : null;

  const upSettings = patch => setState(st=>({ ...st, settings:{ ...st.settings, ...patch } }));
  const toggleEra = e => upSettings({ eras: S.eras.includes(e)
    ? (S.eras.length>1 ? S.eras.filter(x=>x!==e) : S.eras) // never allow zero eras
    : ERAS.filter(x=>S.eras.includes(x) || x===e) });
  const renamePlayer = (i,name) => setState(st=>({ ...st, players: st.players.map((q,j)=> j===i ? {...q, name:name.slice(0,24)} : q) }));
  const removePlayer = i => setState(st=>({ ...st, players: st.players.filter((_,j)=>j!==i) }));
  const addPlayer = () => setState(st=>({ ...st, players:[...st.players, {name:"Player "+(st.players.length+1), score:0}] }));

  async function startGame(){
    engine.stop();
    setLoading(true); setError("");
    const crate = await buildCrate(S.mix, S.eras);
    setLoading(false);
    if (crate.error){
      setError(crate.error==="thin"
        ? "Not enough songs match your filters. Widen the era mix or unblock some artists."
        : "Couldn't load enough songs. Check your connection and try again.");
      setState(st=>({ ...st, screen:"setup" }));
      return;
    }
    setPhase("ready"); setNote(""); setHint(false); setSnip({ end:0, lastSecs:S.snippetLen, playSecs:0 });
    setState(st=>({ ...st, screen:"game",
      players: st.players.map(p=>({ ...p, score:0 })),
      game:{ queue:crate.queue, trackIdx:0, turn:0, round:1, totalSongs:crate.queue.length, source:crate.source } }));
    if (S.sound==="inst") engine.prefetch(crate.queue[0].stream);
  }

  async function playSnippet(secs, mode){ // mode: fresh | replay | extend
    if (!track) return;
    engine.ac(); // unlock inside the tap
    const offset = mode==="extend" ? snip.end : 0;
    const nextSnip = { end: offset + secs, lastSecs: mode==="extend" ? snip.lastSecs : secs, playSecs: secs };
    setNote("");
    const done = ()=>setPhase("guessing");
    if (S.sound === "inst"){
      setPhase("cueing");
      const r = await engine.playMuffled(track.stream, offset, secs, done);
      if (r === "superseded") return;         // user did something newer; obey them
      if (r === "played"){ setSnip(nextSnip); setPhase("playing"); return; }
      setNote("Couldn't process this one — playing it as-is.");
    }
    setSnip(nextSnip);
    setPhase("playing");
    engine.playElement(track.stream, offset, secs, done);
  }

  function revealTrack(){
    if (!track) return;
    const offset = track.duration > 35 ? Math.min(45, Math.max(0, track.duration - 60)) : 0;
    engine.playElement(track.stream, offset, 0, null);
    setPhase("revealed");
  }

  function nextRound(gotIt){
    engine.stop();
    if (track) markPlayed(track.title);
    const pts = hint ? 0.5 : 1; // a hint halves the payout
    setPhase("ready"); setNote(""); setShowBoard(false); setHint(false);
    setSnip(s=>({ ...s, end:0, playSecs:0 }));
    setState(st=>{
      const gg = st.game;
      const players = gotIt===true
        ? st.players.map((p,i)=> i===gg.turn ? { ...p, score:p.score+pts } : p)
        : st.players;
      const turn = gotIt===null ? gg.turn : (gg.turn+1) % players.length; // skip keeps the same player
      const round = (gotIt!==null && turn===0) ? gg.round+1 : gg.round;
      const trackIdx = gg.trackIdx + 1;
      if (trackIdx >= gg.queue.length) return { ...st, players, screen:"done", game:null };
      return { ...st, players, game:{ ...gg, trackIdx, turn, round } };
    });
  }
  useEffect(()=>{ // prefetch the upcoming track whenever it changes
    if (state.screen==="game" && track && S.sound==="inst") engine.prefetch(track.stream);
  }, [g && g.trackIdx, state.screen]);

  function blockArtist(){
    if (!track) return;
    const primary = String(track.artist||"").split(",")[0].trim();
    if (!primary) return;
    const list = loadBlocked();
    const next = list.some(a=>normArtist(a)===normArtist(primary)) ? list : [...list, primary];
    saveBlocked(next);
    setBlocked(next);
    const set = new Set(next.map(normArtist));
    setState(st=>{ // drop the blocked artist's songs still waiting in this crate
      const gg = st.game; if (!gg) return st;
      const queue = gg.queue.filter((t,i)=> i<=gg.trackIdx || !isBlocked(t,set));
      return { ...st, game:{ ...gg, queue, totalSongs:queue.length } };
    });
  }
  function unblockArtist(name){
    const next = loadBlocked().filter(a=>normArtist(a)!==normArtist(name));
    saveBlocked(next);
    setBlocked(next);
  }

  function endGame(){
    if (!confirm("End this game? Scores will be cleared.")) return;
    engine.stop();
    setState(st=>({ ...st, screen:"setup", game:null }));
  }

  if (state.screen === "setup"){
    if (loading) return <Loading />;
    return <Setup error={error} S={S} upSettings={upSettings} toggleEra={toggleEra}
      players={state.players} renamePlayer={renamePlayer} removePlayer={removePlayer} addPlayer={addPlayer}
      blocked={blocked} unblockArtist={unblockArtist} startGame={startGame} />;
  }
  if (state.screen === "done"){
    if (loading) return <Loading />;
    return <Done players={state.players} startGame={startGame}
      toSetup={()=>setState(st=>({ ...st, screen:"setup" }))} />;
  }

  const primaryArtist = track ? String(track.artist||"").split(",")[0].trim() : "";
  const curArtistBlocked = !!primaryArtist && blocked.some(a=>normArtist(a)===normArtist(primaryArtist));
  return <Game g={g} players={state.players} S={S} track={track} phase={phase} snip={snip} note={note}
    hint={hint} useHint={()=>setHint(true)} showBoard={showBoard} toggleBoard={()=>setShowBoard(v=>!v)}
    playSnippet={playSnippet} revealTrack={revealTrack} nextRound={nextRound}
    blockArtist={blockArtist} primaryArtist={primaryArtist} curArtistBlocked={curArtistBlocked} endGame={endGame} />;
}
