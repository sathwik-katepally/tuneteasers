import type { CSSProperties } from "react";
import s from "./Equalizer.module.css";

const BARS = 18;
const ROWS = 6;
const dotClass = (r: number) => (r >= ROWS - 1 ? s.red : r >= ROWS - 3 ? s.hot : s.lit);

/* Bulb-matrix level meter under the cinema screen. It is a pure CSS loop
   (no audio analysis): reading real levels would mean routing the raw
   "snip" element through Web Audio, which the engine deliberately avoids. */
export function Equalizer({ on }: { on: boolean }){
  return (
    <div className={`${s.viz} ${on ? s.on : ""}`} aria-hidden>
      {Array.from({ length: BARS }, (_, i) => (
        <div key={i} className={s.bar} style={{ "--d": `${0.42 + ((i * 37) % 23) / 40}s`, "--o": `${-((i * 53) % 17) / 10}s` } as CSSProperties}>
          <div className={s.layer}>{Array.from({ length: ROWS }, (_, r) => <span key={r} className={s.dot} />)}</div>
          <div className={`${s.layer} ${s.level}`}>{Array.from({ length: ROWS }, (_, r) => <span key={r} className={`${s.dot} ${dotClass(r)}`} />)}</div>
        </div>
      ))}
    </div>
  );
}
