import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { SplitFlap } from "../components/SplitFlap";
import type { GameState } from "../types";
import s from "./Scoreboard.module.css";
import sh from "./shared.module.css";

export function Scoreboard({ game, round, onSettle, onNext }: { game: GameState; round: number; onSettle: () => void; onNext: () => void }){
  const reduce = useReducedMotion();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => { setSettled(true); onSettle(); }, reduce ? 100 : 900);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reels = game.history.filter(h => h.round === round);
  const gained = (id: string) => reels.filter(h => h.id === id).reduce((n, h) => n + h.points, 0);
  const before = (id: string, score: number) => score - gained(id);
  const ordered = [...game.cast].sort((a, b) => (settled ? b.score - a.score : before(b.id, b.score) - before(a.id, a.score)));
  const width = Math.max(3, ...game.cast.map(c => String(c.score).length));
  const names = new Map(game.cast.map(c => [c.id, c.name]));

  // FLIP: rows slide to their new rank when the board settles.
  const rows = useRef(new Map<string, HTMLDivElement>());
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rows.current.forEach((el, id) => {
      const top = el.getBoundingClientRect().top;
      const prev = tops.current.get(id);
      if (!reduce && prev !== undefined && Math.abs(prev - top) > 1)
        el.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "none" }], { duration: 550, easing: "cubic-bezier(0.3, 0.9, 0.3, 1)" });
      next.set(id, top);
    });
    tops.current = next;
  }, [settled, reduce]);

  const final = game.finished;
  const [leader, second] = [...game.cast].sort((a, b) => b.score - a.score);
  const tie = !!second && second.score === leader.score;
  const left = game.totalRounds - round;
  const foot = !settled ? "Tallying"
    : final ? (tie ? "A tie at the top. Credits next." : `${leader.name} takes it. Credits next.`)
    : `${tie ? "Neck and neck at the top" : `${leader.name} leads`}. ${left} round${left === 1 ? "" : "s"} to go.`;

  return (
    <div className={sh.stage}>
      <div className={s.board}>
        <div className={s.head}>
          <h2 className={s.title}>Box office</h2>
          <span className={s.after}>{final ? "Final count" : `After round ${round}`}</span>
        </div>
        <div className={s.rows}>
          {ordered.map((c, i) => {
            const delta = gained(c.id);
            const lead = settled && i === 0 && c.score > 0;
            return (
              <div key={c.id} ref={el => { if (el) rows.current.set(c.id, el); else rows.current.delete(c.id); }}
                className={`${s.row} ${lead ? s.rowLead : ""}`}>
                <span className={`${s.rank} ${lead ? s.rankLead : ""}`}>{i + 1}</span>
                <span className={s.name}>{c.name}</span>
                <span className={`${s.delta} ${delta === 0 ? s.deltaZero : ""}`}>{delta > 0 ? `+${delta}` : "-"}</span>
                <SplitFlap value={settled ? c.score : before(c.id, c.score)} length={width} delay={150} />
              </div>
            );
          })}
        </div>
        {reels.length > 0 && (
          <div className={s.log}>
            <span className={s.logHead}>Reels this round</span>
            {reels.map((h, i) => (
              <div key={i} className={s.logRow}>
                <span className={s.logName}>{names.get(h.id) ?? "Nobody"}</span>
                <span className={s.logSong}>{h.song}</span>
                <span className={`${s.logPts} ${h.points === 0 ? s.deltaZero : ""}`}>{h.points > 0 ? `+${h.points}` : "missed"}</span>
              </div>
            ))}
          </div>
        )}
        <p className={s.foot}>{foot}</p>
      </div>
      <div className={sh.actions}>
        <button type="button" className="btn btn-primary btn-block" onClick={onNext}>{final ? "Roll the credits" : `On to round ${round + 1}`}</button>
      </div>
    </div>
  );
}
