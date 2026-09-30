import { useState } from "react";
import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import { Ticket } from "../components/Ticket";
import type { GameState } from "../types";
import s from "./Handover.module.css";
import sh from "./shared.module.css";

const TEAR_MS = 450;

/* steal: the song was passed on, so this hands it to the next contestant mid-song. */
type Steal = { name: string; from: string; worth: number };

export function Handover({ game, holder, steal, onPrime, onHanded }: { game: GameState; holder: string; steal?: Steal; onPrime: () => void; onHanded: () => void }){
  const reduce = useReducedMotion();
  const [torn, setTorn] = useState(false);
  const who = game.cast[game.turn];
  const name = steal ? steal.name : who.name;
  // The history names whoever scored, which after a steal is not whose turn it was.
  const prev = game.history.length && !steal ? game.cast[(game.turn + game.cast.length - 1) % game.cast.length] : null;
  const isTeam = game.mode === "teams";
  const go = () => {
    if (torn) return;
    onPrime(); // must run inside the tap so the countdown may start audio later
    setTorn(true);
    setTimeout(onHanded, reduce ? 0 : TEAR_MS);
  };
  const note = steal ? "Replay it or hear more if you need to."
    : !isTeam ? "Everyone else, eyes off the screen."
    : holder ? `${holder} holds the phone. The rest of ${who.name}, listen in.`
    : "One of you holds it, the rest listen in.";

  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        {prev && prev.id !== who.id && (
          <m.div className={s.prev} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>{prev.name} is done</m.div>
        )}
        <m.p className={s.eyebrow} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          {steal ? `${steal.from} passed it to` : "Pass the phone to"}
        </m.p>
        <m.div
          initial={reduce ? { opacity: 0 } : { x: "120%", rotate: 10, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { x: 0, rotate: -2, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 22, delay: 0.1 }}
        >
          <Ticket stub={steal ? "Steal" : isTeam ? "Team turn" : "Admit one"} torn={torn}>
            <m.h2 className={s.name}
              initial={reduce ? false : { clipPath: "inset(0 100% 0 0)" }}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              transition={{ duration: 0.7, delay: 0.5, ease: "easeOut" }}>
              {name}
            </m.h2>
            <p className={s.meta}>
              {steal ? `Same song, worth ${steal.worth} now`
                : `Round ${game.round} of ${game.totalRounds} - ${isTeam ? "team" : "turn"} ${game.turn + 1} of ${game.cast.length}`}
            </p>
            {isTeam && holder && !steal && <p className={s.holder}>{holder}'s turn to hold it</p>}
          </Ticket>
        </m.div>
        <m.p className={s.note} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 }}>{note}</m.p>
      </div>
      <div className={sh.actions}>
        <button type="button" className="btn btn-primary btn-block" onClick={go}>
          {steal ? (isTeam ? `We're ${name}, we'll take it` : `It's with me, ${name}`) : isTeam ? `We're ${name}, roll it` : `It's with me, ${name}`}
        </button>
      </div>
    </div>
  );
}
