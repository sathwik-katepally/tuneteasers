import * as m from "motion/react-m";
import { FIRST_CLIP, SOUND_LINE, type LandingProps } from "./facts";
import s from "./LandingC.module.css";

const LIFT = { duration: 1.3, ease: [0.7, 0, 0.2, 1] as const };

export function LandingC({ onStart, onJoin }: LandingProps){
  return (
    <m.div className={s.root} exit={{ opacity: 1 }} transition={{ duration: 1.5 }}>
      <m.div className={`${s.half} ${s.left}`} exit={{ scaleY: 0 }} transition={LIFT} aria-hidden />
      <m.div className={`${s.half} ${s.right}`} exit={{ scaleY: 0 }} transition={{ ...LIFT, delay: 0.08 }} aria-hidden />
      <m.header className={s.pelmet} exit={{ y: "-100%" }} transition={{ ...LIFT, delay: 0.5 }}>
      </m.header>

      <div className={s.scroll}>
        <m.div className={s.cert} initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0, transition: { duration: 0.3 } }}
          transition={{ type: "spring", stiffness: 200, damping: 20, delay: 0.15 }}>
          <div className={s.top}>
            <span className={s.u} aria-label="Rated U">U</span>
            <div>
              <p className={s.kicker}>Certified for exhibition</p>
              <p className={s.sub}>Fit for the whole room</p>
            </div>
          </div>
          <p className={s.pitch}>
            A party game for film songs. Hear a few seconds, then name the song or the film.
            The less you need to hear, the more you score.
          </p>
          <table className={s.fields}>
            <tbody>
              <tr><th>Title</th><td className={s.name}>Tune Teasers</td></tr>
              <tr><th>Language</th><td>Hindi, Telugu</td></tr>
              <tr><th>Length</th><td>{FIRST_CLIP} seconds, more if you're stuck</td></tr>
              <tr><th>Seating</th><td>Pass one phone round, or buzz in from your own</td></tr>
              <tr><th>Tickets</th><td>Free, no sign-up</td></tr>
            </tbody>
          </table>
          <p className={s.sound}>{SOUND_LINE}</p>
          <div className={s.actions}>
            <button type="button" className="btn btn-primary btn-block" onClick={onStart}>Roll the film</button>
            <button type="button" className={`link ${s.join}`} onClick={onJoin}>Have a room code? Join the room</button>
          </div>
        </m.div>
      </div>
    </m.div>
  );
}
