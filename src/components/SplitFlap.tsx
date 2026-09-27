import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import s from "./SplitFlap.module.css";

const DIGITS = " 0123456789";

/* A box-office number board: each cell flips through the digits until it
   lands on the target, like the old mechanical boards. */
export function SplitFlap({ value, length, delay = 0 }: { value: number; length: number; delay?: number }){
  const goal = String(value).slice(-length).padStart(length, " ");
  const [shown, setShown] = useState(goal);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (shown === goal) return;
    if (reduce){ setShown(goal); return; }
    let iv = 0;
    const start = window.setTimeout(() => {
      iv = window.setInterval(() => {
        setShown(cur => {
          let next = "";
          for (let i = 0; i < length; i++){
            const c = cur[i] ?? " ", g = goal[i] ?? " ";
            next += c === g ? c : DIGITS[(DIGITS.indexOf(c) + 1) % DIGITS.length];
          }
          if (next === goal) window.clearInterval(iv);
          return next;
        });
      }, 65);
    }, delay);
    return () => { window.clearTimeout(start); window.clearInterval(iv); };
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className={s.board} role="img" aria-label={String(value)}>
      {shown.split("").map((c, i) => (
        <span key={i} className={s.cell}><span key={c} className={s.char}>{c}</span></span>
      ))}
    </span>
  );
}
