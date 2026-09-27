import { useState } from "react";
import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import { Ticket } from "../components/Ticket";
import type { GameState } from "../types";
import s from "./Handover.module.css";
import sh from "./shared.module.css";

const TEAR_MS = 450;

export function Handover({ game, holder, onPrime, onHanded }: { game: GameState; holder: string; onPrime: () => void; onHanded: () => void }){
  const reduce = useReducedMotion();
  const [torn, setTorn] = useState(false);
  const who = game.cast[game.turn];
  const prev = game.history.length ? game.cast.find(c => c.id === game.history[game.history.length - 1].id) : null;
  const isTeam = game.mode === "teams";
  const go = () => {
    if (torn) return;
    onPrime(); // must run inside the tap so the countdown may start audio later
    setTorn(true);
    setTimeout(onHanded, reduce ? 0 : TEAR_MS);
  };
  const note = !isTeam ? "Everyone else, eyes off the screen."
    : holder ? `${holder} holds the phone. The rest of ${who.name}, listen in.`
    : "One of you holds it, the rest listen in.";

  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        {prev && prev.id !== who.id && (
          <m.div className={s.prev} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>{prev.name} is done</m.div>
        )}
        <m.p className={s.eyebrow} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          Pass the phone to
        </m.p>
        <m.div
          initial={reduce ? { opacity: 0 } : { x: "120%", rotate: 10, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { x: 0, rotate: -2, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 22, delay: 0.1 }}
        >
          <Ticket stub={isTeam ? "Team turn" : "Admit one"} torn={torn}>
            <m.h2 className={s.name}
              initial={reduce ? false : { clipPath: "inset(0 100% 0 0)" }}
              animate={{ clipPath: "inset(0 0% 0 0)" }}
              transition={{ duration: 0.7, delay: 0.5, ease: "easeOut" }}>
              {who.name}
            </m.h2>
            <p className={s.meta}>
              Round {game.round} of {game.totalRounds} - {isTeam ? "team" : "turn"} {game.turn + 1} of {game.cast.length}
            </p>
            {isTeam && holder && <p className={s.holder}>{holder}'s turn to hold it</p>}
          </Ticket>
        </m.div>
        <m.p className={s.note} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 }}>{note}</m.p>
      </div>
      <div className={sh.actions}>
        <button type="button" className="btn btn-primary btn-block" onClick={go}>
          {isTeam ? `We're ${who.name}, roll it` : `It's with me, ${who.name}`}
        </button>
      </div>
    </div>
  );
}
