import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import s from "./Bulbs.module.css";

export type BulbMode = "chase" | "fast" | "steady" | "twinkle";

const modeClass: Record<BulbMode, string> = {
  chase: s.chase,
  fast: s.fast,
  steady: s.lit,
  twinkle: `${s.lit} ${s.twinkle}`,
};

const Bulb = ({ i, mode }: { i: number; mode: BulbMode }) =>
  <span className={`${s.bulb} ${modeClass[mode]}`} style={{ "--i": i, "--t": (i * 7) % 11 } as CSSProperties} />;

function useBox<T extends HTMLElement>(){
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => { if (e) setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

const range = (n: number, from = 0) => Array.from({ length: Math.max(0, n) }, (_, i) => from + i);

/* A marquee border of bulbs around the nearest positioned ancestor.
   Indices run clockwise so "chase" travels around the frame. */
export function BulbFrame({ mode = "chase", gap = 24, inset = 0, size = 10 }: { mode?: BulbMode; gap?: number; inset?: number; size?: number }){
  const [ref, box] = useBox<HTMLDivElement>();
  const cols = Math.max(2, Math.round((box.w - inset * 2) / gap) + 1);
  const rows = Math.max(0, Math.round((box.h - inset * 2) / gap) - 1);
  const vars = { "--inset": `${inset}px`, "--gap": `${gap}px`, "--size": `${size}px` } as CSSProperties;
  const side = (cls: string, ids: number[]) =>
    <div className={`${s.side} ${cls}`}>{ids.map(i => <Bulb key={i} i={i} mode={mode} />)}</div>;
  return (
    <div ref={ref} className={s.frame} style={vars} aria-hidden>
      {box.w > 0 && <>
        {side(s.top, range(cols))}
        {side(s.right, range(rows, cols))}
        {side(s.bottom, range(cols, cols + rows).reverse())}
        {side(s.left, range(rows, cols * 2 + rows).reverse())}
      </>}
    </div>
  );
}

export function BulbRow({ mode = "chase", gap = 22, size = 8, className = "" }: { mode?: BulbMode; gap?: number; size?: number; className?: string }){
  const [ref, box] = useBox<HTMLDivElement>();
  const n = box.w ? Math.max(2, Math.floor(box.w / gap) + 1) : 0;
  return (
    <div ref={ref} className={`${s.row} ${className}`} style={{ "--size": `${size}px` } as CSSProperties} aria-hidden>
      {range(n).map(i => <Bulb key={i} i={i} mode={mode} />)}
    </div>
  );
}
