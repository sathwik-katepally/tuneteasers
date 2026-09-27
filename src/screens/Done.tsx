import { fmtScore } from "../lib/utils.js";
import { ScoreRow } from "../components/bits";
import type { Player } from "../types";

export function Done({ players, startGame, toSetup }: { players: Player[]; startGame: () => void; toSetup: () => void }){
  const ranked = [...players].sort((a,b)=>b.score-a.score);
  return (
    <div className="wrap center" key="done" style={{ paddingTop: "16vh" }}>
      <div style={{ fontSize: "46px" }}>🏆</div>
      <h2 className="display" style={{ fontSize: "30px", fontWeight: "800", margin: "6px 0 18px" }}>{ranked[0].name} takes it!</h2>
      <div className="card" style={{ textAlign: "left" }}>
        {ranked.map((p,i)=>(
          <ScoreRow key={p.name+i} left={`${i+1}. ${p.name}`} right={fmtScore(p.score)}
            style={{ fontWeight: i===0?800:600, color: i===0?'var(--marigold)':'var(--cream)', ...(i<ranked.length-1 ? { borderBottom: '1px solid var(--surface2)' } : {}) }} />
        ))}
      </div>
      <button className="btn btn-gold" onClick={startGame}>Play again</button>
      <div className="gap"></div>
      <button className="btn btn-ghost" onClick={toSetup}>Change settings</button>
    </div>
  );
}
