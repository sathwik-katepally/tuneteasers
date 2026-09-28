import { useEffect } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { ladderFor } from "../lib/config";
import { markLandingSeen } from "../lib/save";
import type { Play } from "../types";
import s from "./Landing.module.css";

/* Easy's ladder: the first clip, then each "Hear more" step. */
const EASY = ladderFor(true);
const LADDER = EASY.segments.map((secs, i) => ({ label: i === 0 ? `${secs}s` : `+${secs}s`, points: EASY.points[i] }));

const rise = (i: number) => ({
  initial: { y: 28, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  transition: { delay: 0.1 + i * 0.09, type: "spring" as const, stiffness: 300, damping: 26 },
});

/* What the game is, shown on a first visit and from the About button. */
export function Landing({ onStart, onJoin }: { onStart: (play: Play) => void; onJoin: () => void }){
  useEffect(() => { markLandingSeen(); window.scrollTo(0, 0); }, []);
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <main className={s.root}>
          <div className={s.rays} aria-hidden />
          <div className={s.grid}>
            <div className={s.hero}>
              <p className={s.brand}>Tune Teasers</p>
              <h1 className={s.head}>
                <m.span className={s.line} {...rise(0)}>Which film</m.span>
                <m.span className={s.line} {...rise(1)}>is this <em>song</em></m.span>
                <m.span className={s.line} {...rise(2)}>from?</m.span>
              </h1>
              <m.p className={s.lede} {...rise(3)}>
                A party game for Hindi and Telugu film songs. Hear a few seconds, then name the song or the film.
              </m.p>
            </div>

            <div className={s.side}>
              <m.div {...rise(4)}>
                <p className={s.label}>The less you hear, the more it's worth</p>
                <ol className={s.ladder}>
                  {LADDER.map(r => (
                    <li key={r.label} className={s.rung}>
                      <span className={s.secs}>{r.label}</span>
                      <span className={s.pts}>{r.points} pts</span>
                    </li>
                  ))}
                </ol>
              </m.div>

              <m.div className={s.actions} {...rise(5)}>
                <button type="button" className={s.mode} onClick={() => onStart("pass")}>
                  <span className={s.modeTitle}>Pass one phone</span>
                  <span className={s.modeSub}>Everyone takes turns on this phone.</span>
                </button>
                <button type="button" className={`${s.mode} ${s.modeRoom}`} onClick={() => onStart("room")}>
                  <span className={s.modeTitle}>Buzz in from every phone</span>
                  <span className={s.modeSub}>This screen plays, friends join with a code.</span>
                </button>
                <button type="button" className={`link ${s.join}`} onClick={onJoin}>Got a code? Join a show</button>
              </m.div>
            </div>
          </div>
        </main>
      </MotionConfig>
    </LazyMotion>
  );
}
