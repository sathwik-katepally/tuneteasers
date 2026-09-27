import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import s from "./Stamp.module.css";

export function Stamp({ text, sub, rotate = -9 }: { text: string; sub?: string; rotate?: number }){
  const reduce = useReducedMotion();
  return (
    <m.div
      className={s.stamp}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 2.6, rotate: rotate - 12 }}
      animate={{ opacity: 1, scale: 1, rotate }}
      transition={reduce ? { duration: 0.2 } : { type: "spring", stiffness: 700, damping: 26, mass: 0.9 }}
    >
      {text}
      {sub && <small>{sub}</small>}
    </m.div>
  );
}
