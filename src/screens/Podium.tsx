import type { CSSProperties } from "react";
import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import { BulbFrame } from "../components/Bulbs";
import type { CastMember } from "../types";
import s from "./Podium.module.css";
import sh from "./shared.module.css";

const HEIGHTS = [150, 100, 76];
const CONFETTI = Array.from({ length: 16 }, (_, i) => ({
  left: `${(i * 61) % 100}%`, "--delay": `${1.6 + ((i * 0.37) % 3)}s`, "--dur": `${4 + ((i * 7) % 5) * 0.5}s`,
  "--rot": `${(i * 47) % 360}deg`, background: i % 3 === 0 ? "var(--vermilion)" : "var(--cream)",
} as CSSProperties));

export function Podium({ cast, onAgain, onNewShow }: { cast: CastMember[]; onAgain: () => void; onNewShow: () => void }){
  const reduce = useReducedMotion();
  const ranked = [...cast].sort((a, b) => b.score - a.score);
  const place = (c: CastMember) => ranked.findIndex(r => r.score === c.score) + 1;
  const top = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const slots = top.length === 1 ? [top[0]] : top.length === 2 ? [top[1], top[0]] : [top[1], top[0], top[2]];
  const delays = top.length === 3 ? [0.6, 1.0, 0.3] : [0.6, 1.0];
  const winners = ranked.filter(c => c.score === ranked[0].score);
  const headline = winners.length === 1 ? `${winners[0].name} takes it`
    : winners.length === 2 ? `${winners[0].name} and ${winners[1].name} tie`
    : "A tie at the top";

  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        <div className={s.head}>
          <BulbFrame mode="twinkle" gap={20} inset={6} size={8} />
          <p className={s.eyebrow}>Premiere night</p>
          <m.h2 className={s.winner} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: reduce ? 0 : 1.4, type: "spring", stiffness: 300, damping: 18 }}>
            {headline}
          </m.h2>
        </div>

        <div className={`${s.stageFloor} ${s[`n${slots.length}`]}`}>
          {!reduce && <>
            <svg className={`${s.spot} ${s.spotL}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <polygon points="6,0 30,100 78,100" fill="#ffd36b" opacity="0.11" />
              <polygon points="6,0 44,100 64,100" fill="#fff1c9" opacity="0.12" />
            </svg>
            <svg className={`${s.spot} ${s.spotR}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <polygon points="94,0 22,100 70,100" fill="#ffd36b" opacity="0.11" />
              <polygon points="94,0 36,100 56,100" fill="#fff1c9" opacity="0.12" />
            </svg>
            {CONFETTI.map((style, i) => <span key={i} className={s.confetti} style={style} aria-hidden />)}
          </>}
          {slots.map((c, i) => (
            <m.div key={c.id} className={`${s.col} ${place(c) === 1 ? s.first : ""}`}
              initial={reduce ? { opacity: 0 } : { y: 200, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
              transition={{ delay: reduce ? 0 : delays[i], type: "spring", stiffness: 260, damping: 22 }}>
              <span className={s.colName}>{c.name}</span>
              <span className={s.colScore}>{c.score}</span>
              <div className={s.block} style={{ height: HEIGHTS[place(c) - 1] }}>
                <span className={s.blockNum}>{place(c)}</span>
              </div>
            </m.div>
          ))}
        </div>
        {rest.length > 0 && (
          <div className={s.rest}>
            {rest.map(c => <span key={c.id}>{place(c)}. <b>{c.name}</b> {c.score}</span>)}
          </div>
        )}
      </div>
      <div className={sh.actions}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-ghost" onClick={onNewShow}>New show</button>
          <button type="button" className="btn btn-primary" onClick={onAgain}>Same crowd again</button>
        </div>
      </div>
    </div>
  );
}
