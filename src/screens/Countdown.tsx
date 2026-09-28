import { useEffect, useState } from "react";
import * as m from "motion/react-m";
import { AnimatePresence, useReducedMotion } from "motion/react";
import { BulbFrame } from "../components/Bulbs";
import s from "./Countdown.module.css";
import sh from "./shared.module.css";

/* skipped: the title of a song just skipped as heard too much, shown so the room sees it. */
export function Countdown({ onTick, onDone, skipped = "" }: { onTick: (n: number) => void; onDone: () => void; skipped?: string }){
  const reduce = useReducedMotion();
  const [n, setN] = useState(3);
  useEffect(() => {
    const step = reduce ? 500 : 800;
    onTick(3);
    const ids = [1, 2, 3, 4].map(k => window.setTimeout(() => {
      if (k < 4){ setN(3 - k); onTick(3 - k); } else onDone();
    }, step * k));
    return () => ids.forEach(id => window.clearTimeout(id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        <BulbFrame mode="fast" gap={22} inset={12} size={11} />
        {skipped && (
          <p className={s.skipped} role="status">
            <span className={s.skippedLabel}>Skipped</span>
            <span className={s.skippedTitle}>{skipped}</span>
          </p>
        )}
        <AnimatePresence>
          {n > 0 ? (
            <m.div key={n} className={s.num} aria-live="polite"
              initial={{ scale: 1.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.7, opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 28 }}>
              {n}
            </m.div>
          ) : (
            <m.div key="go" className={s.go} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}>
              Roll it
            </m.div>
          )}
        </AnimatePresence>
        <p className={s.label}>{skipped ? "Another one, same level" : "Ears on"}</p>
      </div>
    </div>
  );
}
