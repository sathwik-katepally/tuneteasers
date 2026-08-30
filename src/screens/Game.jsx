import { fmtScore } from "../lib/utils.js";
import { Disc, ScoreRow } from "../components/bits.jsx";

export function Game(props){
  const { g, players, S, track, phase, snip, note, hint, useHint, showBoard, toggleBoard,
          playSnippet, revealTrack, nextRound, blockArtist, primaryArtist, curArtistBlocked, endGame } = props;
  const cur = players[g.turn];
  const spinning = phase==="playing" || phase==="revealed";
  const revealed = phase==="revealed";
  return (
    <div class="wrap" key="game">
      <div class="topbar">
        <div class="sub" style="font-size:13px;font-weight:600">Round {g.round}</div>
        <button class="scorebtn" onClick={toggleBoard}>{showBoard?"Hide scores":"Scores"}</button>
      </div>
      {showBoard && (
        <div class="card" style="padding:12px;margin-bottom:10px">
          {players.map((p,i)=>({p,i})).sort((a,b)=>b.p.score-a.p.score).map(({p,i})=>(
            <ScoreRow key={p.name+i} left={`${p.name}${i===g.turn?" ← up now":""}`} right={fmtScore(p.score)}
              style={`font-weight:${i===g.turn?800:500};color:${i===g.turn?'var(--marigold)':'var(--cream)'}`} />
          ))}
        </div>
      )}
      <div class="turnbar">
        <div class="tag">PHONE GOES TO</div>
        <div class="who">{cur.name}</div>
      </div>
      <Disc spinning={spinning} art={revealed && track ? track.art : null} />
      {phase==="playing" && snip.playSecs>0 && (
        <div class="progress"><div style={`animation: fill ${snip.playSecs}s linear forwards`}></div></div>
      )}
      {phase==="ready" && <>
        <p class="center sub" style="margin-bottom:14px">Everyone quiet — {cur.name}, hit play when ready.</p>
        <button class="btn btn-gold" onClick={()=>playSnippet(S.snippetLen, "fresh")}>▶ Play {S.snippetLen}-second snippet</button>
        <div class="gap"></div>
        <button class="btn btn-ghost" onClick={()=>nextRound(null)}>Skip this song</button>
      </>}
      {phase==="cueing" && <>
        <p class="center display" style="font-size:18px;font-weight:700;margin-bottom:14px">Cueing it up…</p>
        <button class="btn btn-dark" disabled>One sec</button>
      </>}
      {phase==="playing" && <>
        <p class="center display" style="font-size:20px;font-weight:700;margin-bottom:14px">Listen closely… 🎧</p>
        {note && <div class="notice" style="margin:-6px 0 12px">{note}</div>}
        <button class="btn btn-rose" onClick={revealTrack}>I know it! Reveal</button>
      </>}
      {phase==="guessing" && <>
        <p class="center sub" style="margin-bottom:14px">Say your guess out loud, then reveal.</p>
        {hint && track && (
          <div class="card center" style="padding:12px;border:1.5px solid #FFB62755;margin-bottom:14px">
            <div style="color:var(--marigold);font-weight:700">💡 {track.album ? `From "${track.album}"` : "No movie on record"}{track.year ? ` · ${track.year}` : ""}</div>
          </div>
        )}
        <button class="btn btn-rose" onClick={revealTrack}>Reveal the song</button>
        <div class="gap"></div>
        <div class="row2">
          <button class="btn btn-ghost" onClick={()=>playSnippet(snip.lastSecs, "replay")}>🔁 Replay</button>
          <button class="btn btn-ghost" onClick={()=>playSnippet(5, "extend")}>＋5 more secs</button>
        </div>
        {!hint && <>
          <div class="gap"></div>
          <button class="btn btn-ghost" style="padding:10px;font-size:13px" onClick={useHint}>💡 Hint: movie ＆ year — costs ½ point</button>
        </>}
      </>}
      {revealed && track && <>
        <div class="center" style="margin-bottom:16px">
          <div class="answer-title">{track.title}</div>
          <div class="answer-artist">{track.artist}</div>
          {track.album && <div class="answer-album">{track.album}{track.year ? ` · ${track.year}` : ""}</div>}
        </div>
        <div class="row2">
          <button class="btn btn-teal" onClick={()=>nextRound(true)}>✓ Got it (+{hint?"½":"1"})</button>
          <button class="btn btn-dark" onClick={()=>nextRound(false)}>✗ Missed</button>
        </div>
        {primaryArtist && <>
          <div class="gap"></div>
          <button class="btn btn-ghost" style="padding:10px;font-size:13px" disabled={curArtistBlocked} onClick={blockArtist}>
            {curArtistBlocked ? `✓ ${primaryArtist} won't play again` : `🚫 Don't play ${primaryArtist} again`}
          </button>
        </>}
      </>}
      <div class="footnote">
        Song {Math.min(g.trackIdx+1, g.totalSongs)} of {g.totalSongs} in the crate
        {track ? ` · ${track.lang==="bolly" ? "Bollywood" : "Telugu"}` : ""}
        {g.source==="live" ? " · live search" : ""}
        <br/><a href="#" onClick={e=>{e.preventDefault(); endGame();}}>End game</a>
      </div>
    </div>
  );
}
