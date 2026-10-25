import type { CSSProperties } from "react";
import s from "./Seg.module.css";

interface Props<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  tone?: "red" | "teal";
  label: string;
}

/* Segmented radio group; the selected pill slides between options in CSS. */
export function Seg<T extends string>({ value, options, onChange, tone = "red", label }: Props<T>){
  const idx = Math.max(0, options.findIndex(o => o.value === value));
  const vars = { "--n": options.length, "--idx": idx } as CSSProperties;
  return (
    <div className={`${s.seg} ${tone === "teal" ? s.teal : ""}`} role="radiogroup" aria-label={label} style={vars}>
      <span className={s.pill} aria-hidden />
      {options.map(o => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} className={`${s.opt} ${on ? s.on : ""}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* The same bar as Seg with any number of options on (toggle buttons); the
   last one on stays on, since a show needs at least one. */
export function MultiSeg<T extends string>({ value, options, onChange, label }: {
  value: readonly T[]; options: { value: T; label: string }[]; onChange: (v: T[]) => void; label: string;
}){
  const vars = { "--n": options.length } as CSSProperties;
  return (
    <div className={`${s.seg} ${options.length > 3 ? s.many : ""}`} role="group" aria-label={label} style={vars}>
      {options.map(o => {
        const on = value.includes(o.value);
        const last = on && value.length === 1;
        return (
          <button key={o.value} type="button" aria-pressed={on} aria-disabled={last} className={`${s.opt} ${on ? s.fill : ""}`}
            onClick={() => { if (!last) onChange(options.map(x => x.value).filter(v => (v === o.value ? !on : value.includes(v)))); }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
