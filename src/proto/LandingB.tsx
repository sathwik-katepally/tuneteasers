import { useState } from "react";
import * as m from "motion/react-m";
import { Theatre } from "../components/Theatre";
import { FIRST_CLIP, SOUND_LINE, type LandingProps } from "./facts";
import s from "./LandingB.module.css";

const TEAR_MS = 520;

export function LandingB({ onStart, onJoin }: LandingProps){
  const [torn, setTorn] = useState(false);
  const tear = () => { if (torn) return; setTorn(true); setTimeout(onStart, TEAR_MS); };
  return (
    <m.div className={s.root} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
      <Theatre meta="Box office open" game={null} onHome={() => {}} onEnd={() => {}}>
        <div className={s.stage}>
          <m.div className={`${s.ticket} ${torn ? s.torn : ""}`} initial={{ y: 24, opacity: 0, rotate: -3 }} animate={{ y: 0, opacity: 1, rotate: -1 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}>
            <div className={s.body}>
              <p className={s.kicker}>A party game for film songs</p>
              <h2 className={s.head}>Guess the song from {FIRST_CLIP} seconds</h2>
              <dl className={s.fields}>
                <dt>Songs</dt>
                <dd>Hindi and Telugu film hits</dd>
                <dt>You say</dt>
                <dd>The song or the film. Stuck? Hear more, for fewer points.</dd>
                <dt>Seats</dt>
                <dd>Pass one phone round, or buzz in from your own</dd>
                <dt>Price</dt>
                <dd>Free, no sign-up</dd>
              </dl>
            </div>
            <button type="button" className={s.stub} onClick={tear} tabIndex={-1} aria-hidden><span>Tear here</span></button>
          </m.div>
          <p className={s.sound}>{SOUND_LINE}</p>
          <div className={s.actions}>
            <button type="button" className="btn btn-primary btn-block" onClick={tear}>Tear the ticket</button>
            <button type="button" className="link" onClick={onJoin}>Joining someone's room? Enter the code</button>
          </div>
        </div>
      </Theatre>
    </m.div>
  );
}
