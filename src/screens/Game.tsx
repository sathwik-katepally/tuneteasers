import { fmtScore } from "../lib/utils.js";
import { Disc, ScoreRow } from "../components/bits";
import type { GameState, Phase, Player, Settings, Snippet, Track } from "../types";

interface GameProps {
  g: GameState;
  players: Player[];
  S: Settings;
  track: Track | null | undefined;
  phase: Phase;
  snip: Snippet;
  note: string;
  hint: boolean;
  useHint: () => void;
  showBoard: boolean;
  toggleBoard: () => void;
  playSnippet: (secs: number, mode: "fresh" | "replay" | "extend") => void;
  revealTrack: () => void;
  nextRound: (gotIt: boolean | null) => void;
  blockArtist: () => void;
  primaryArtist: string;
  curArtistBlocked: boolean;
  endGame: () => void;
  goHome: () => void;
}

export function Game(props: GameProps){
  const { g, players, S, track, phase, snip, note, hint, useHint, showBoard, toggleBoard,
          playSnippet, revealTrack, nextRound, blockArtist, primaryArtist, curArtistBlocked, endGame, goHome } = props;
  const cur = players[g.turn];
  const spinning = phase==="playing" || phase==="revealed";
  const revealed = phase==="revealed";
  return (
    <div className="wrap" key="game">
      <div className="topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button className="scorebtn" aria-label="Back to home" onClick={goHome}>← Home</button>
          <div className="sub" style={{ fontSize: "13px", fontWeight: "600" }}>Round {g.round}</div>
        </div>
        <button className="scorebtn" onClick={toggleBoard}>{showBoard?"Hide scores":"Scores"}</button>
      </div>
      {showBoard && (
        <div className="card" style={{ padding: "12px", marginBottom: "10px" }}>
          {players.map((p,i)=>({p,i})).sort((a,b)=>b.p.score-a.p.score).map(({p,i})=>(
            <ScoreRow key={p.name+i} left={`${p.name}${i===g.turn?" ← up now":""}`} right={fmtScore(p.score)}
              style={{ fontWeight: i===g.turn?800:500, color: i===g.turn?'var(--marigold)':'var(--cream)' }} />
          ))}
        </div>
      )}
      <div className="turnbar">
        <div className="tag">PHONE GOES TO</div>
        <div className="who">{cur.name}</div>
      </div>
      <Disc spinning={spinning} art={revealed && track ? track.art : null} />
      {phase==="playing" && snip.playSecs>0 && (
        <div className="progress"><div style={{ animation: `fill ${snip.playSecs}s linear forwards` }}></div></div>
      )}
      {phase==="ready" && <>
        <p className="center sub" style={{ marginBottom: "14px" }}>Everyone quiet — {cur.name}, hit play when ready.</p>
        <button className="btn btn-gold" onClick={()=>playSnippet(S.snippetLen, "fresh")}>▶ Play {S.snippetLen}-second snippet</button>
        <div className="gap"></div>
        <button className="btn btn-ghost" onClick={()=>nextRound(null)}>Skip this song</button>
      </>}
      {phase==="cueing" && <>
        <p className="center display" style={{ fontSize: "18px", fontWeight: "700", marginBottom: "14px" }}>Cueing it up…</p>
        <button className="btn btn-dark" disabled>One sec</button>
      </>}
      {phase==="playing" && <>
        <p className="center display" style={{ fontSize: "20px", fontWeight: "700", marginBottom: "14px" }}>Listen closely… 🎧</p>
        {note && <div className="notice" style={{ margin: "-6px 0 12px" }}>{note}</div>}
        <button className="btn btn-rose" onClick={revealTrack}>I know it! Reveal</button>
      </>}
      {phase==="guessing" && <>
        <p className="center sub" style={{ marginBottom: "14px" }}>Say your guess out loud, then reveal.</p>
        {note && <div className="notice" style={{ margin: "-6px 0 12px" }}>{note}</div>}
        {hint && track && (
          <div className="card center" style={{ padding: "12px", border: "1.5px solid #FFB62755", marginBottom: "14px" }}>
            <div style={{ color: "var(--marigold)", fontWeight: "700" }}>💡 {track.album ? `From "${track.album}"` : "No movie on record"}{track.year ? ` · ${track.year}` : ""}</div>
          </div>
        )}
        <button className="btn btn-rose" onClick={revealTrack}>Reveal the song</button>
        <div className="gap"></div>
        <div className="row2">
          <button className="btn btn-ghost" onClick={()=>playSnippet(snip.lastSecs, "replay")}>🔁 Replay</button>
          <button className="btn btn-ghost" onClick={()=>playSnippet(5, "extend")}>＋5 more secs</button>
        </div>
        {!hint && <>
          <div className="gap"></div>
          <button className="btn btn-ghost" style={{ padding: "10px", fontSize: "13px" }} onClick={useHint}>💡 Hint: movie ＆ year — costs ½ point</button>
        </>}
      </>}
      {revealed && track && <>
        {note && <div className="notice" style={{ margin: "0 0 10px" }}>{note}</div>}
        <div className="center" style={{ marginBottom: "16px" }}>
          <div className="answer-title">{track.title}</div>
          <div className="answer-artist">{track.artist}</div>
          {track.album && <div className="answer-album">{track.album}{track.year ? ` · ${track.year}` : ""}</div>}
        </div>
        <div className="row2">
          <button className="btn btn-teal" onClick={()=>nextRound(true)}>✓ Got it (+{hint?"½":"1"})</button>
          <button className="btn btn-dark" onClick={()=>nextRound(false)}>✗ Missed</button>
        </div>
        {primaryArtist && <>
          <div className="gap"></div>
          <button className="btn btn-ghost" style={{ padding: "10px", fontSize: "13px" }} disabled={curArtistBlocked} onClick={blockArtist}>
            {curArtistBlocked ? `✓ ${primaryArtist} won't play again` : `🚫 Don't play ${primaryArtist} again`}
          </button>
        </>}
      </>}
      <div className="footnote">
        Song {Math.min(g.trackIdx+1, g.totalSongs)} of {g.totalSongs} in the crate
        {track ? ` · ${track.lang==="bolly" ? "Bollywood" : "Telugu"}` : ""}
        {g.source==="live" ? " · live search" : ""}
        <br/><a href="#" onClick={e=>{e.preventDefault(); endGame();}}>End game</a>
      </div>
    </div>
  );
}
