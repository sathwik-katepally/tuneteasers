import { fmtScore } from "../lib/utils.js";
import { ScoreRow } from "../components/bits.jsx";

export function Done({ players, startGame, toSetup }){
  const ranked = [...players].sort((a,b)=>b.score-a.score);
  return (
    <div class="wrap center" key="done" style="padding-top:16vh">
      <div style="font-size:46px">🏆</div>
      <h2 class="display" style="font-size:30px;font-weight:800;margin:6px 0 18px">{ranked[0].name} takes it!</h2>
      <div class="card" style="text-align:left">
        {ranked.map((p,i)=>(
          <ScoreRow key={p.name+i} left={`${i+1}. ${p.name}`} right={fmtScore(p.score)}
            style={`font-weight:${i===0?800:600};color:${i===0?'var(--marigold)':'var(--cream)'};${i<ranked.length-1?'border-bottom:1px solid var(--surface2)':''}`} />
        ))}
      </div>
      <button class="btn btn-gold" onClick={startGame}>Play again</button>
      <div class="gap"></div>
      <button class="btn btn-ghost" onClick={toSetup}>Change settings</button>
    </div>
  );
}
