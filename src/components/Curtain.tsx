import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import s from "./Curtain.module.css";

export function Curtain({ open }: { open: boolean }){
  const reduce = useReducedMotion();
  const lift = { scaleY: open ? 0.04 : 1 };
  const t = reduce ? { duration: 0.01 } : { duration: 1.4, ease: [0.7, 0, 0.2, 1] as const };
  return (
    <div className={s.wrap} aria-hidden>
      <div className={s.pelmet} />
      <m.div className={`${s.half} ${s.leftHalf}`} initial={false} animate={lift} transition={t} />
      <m.div className={`${s.half} ${s.rightHalf}`} initial={false} animate={lift} transition={{ ...t, delay: reduce ? 0 : 0.08 }} />
    </div>
  );
}
