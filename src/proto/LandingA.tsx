import * as m from "motion/react-m";
import { BulbFrame } from "../components/Bulbs";
import { FIRST_CLIP, SOUND_LINE, type LandingProps } from "./facts";
import s from "./LandingA.module.css";

const BOARD = ["GUESS THE", "FILM SONG"];

export function LandingA({ onStart, onJoin }: LandingProps){
  let n = 0;
  return (
    <m.div className={s.root} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}>
      <div className={s.col}>
        <div className={s.sign}>
          <BulbFrame mode="chase" gap={22} size={9} inset={10} />
          <p className={s.now}>Now showing</p>
          <h1 className={s.title}>Tune Teasers</h1>
          <div className={s.board} role="img" aria-label={BOARD.join(" ")}>
            {BOARD.map(line => (
              <div key={line} className={s.rail}>
                {[...line].map((ch, i) => ch === " "
                  ? <span key={i} className={s.gap} />
                  : <m.span key={i} className={s.tile} initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.25 + n++ * 0.045, type: "spring", stiffness: 520, damping: 22 }}>{ch}</m.span>)}
              </div>
            ))}
          </div>
        </div>

        <p className={s.lede}>
          Hear {FIRST_CLIP} seconds of a Hindi or Telugu film song and call out the song or the film.
          Stuck? Hear a bit more, for fewer points.
        </p>
        <p className={s.modes}>Pass one phone round the room, or play the songs on one screen and buzz in from your own phones.</p>

        <div className={s.actions}>
          <button type="button" className="btn btn-primary" onClick={onStart}>Take your seats</button>
          <button type="button" className="link" onClick={onJoin}>Got a room code? Join the room</button>
        </div>
        <p className={s.fine}>Free, no sign-up. {SOUND_LINE}</p>
      </div>
    </m.div>
  );
}
