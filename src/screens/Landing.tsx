import { useEffect } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { CLIP_POINTS, CLIP_SEGMENTS } from "../lib/config";
import { markLandingSeen } from "../lib/save";
import s from "./Landing.module.css";

/* Easy's ladder: the first clip, then each "Hear more" step. */
const LADDER = CLIP_SEGMENTS.map((secs, i) => ({ label: i === 0 ? `${secs}s` : `+${secs}s`, points: CLIP_POINTS[i] }));

const rise = (i: number) => ({
  initial: { y: 28, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  transition: { delay: 0.1 + i * 0.09, type: "spring" as const, stiffness: 300, damping: 26 },
});

/* What the game is, shown on a first visit and from the About button. */
export function Landing({ onStart, onJoin }: { onStart: () => void; onJoin: () => void }){
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

              <m.dl className={s.modes} {...rise(5)}>
                <div><dt>Pass the phone</dt><dd>One phone goes round the room.</dd></div>
                <div><dt>Buzz in</dt><dd>One screen plays, everyone buzzes from their own phone.</dd></div>
              </m.dl>

              <m.div className={s.actions} {...rise(6)}>
                <button type="button" className="btn btn-primary btn-block" onClick={onStart}>Set up a game</button>
                <button type="button" className="link" onClick={onJoin}>Join with a code</button>
              </m.div>
            </div>
          </div>
        </main>
      </MotionConfig>
    </LazyMotion>
  );
}
