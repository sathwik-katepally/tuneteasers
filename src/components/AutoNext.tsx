import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useNow } from "./ClipStrip";
import s from "./AutoNext.module.css";

interface Props {
  secs: number;
  label: string;
  /* auto is true when the countdown ran out, false for a tap (which may start audio). */
  onGo: (auto: boolean) => void;
  /* A new value starts the countdown over (the lobby restarts it on every join). */
  restart?: unknown;
  disabled?: boolean;
  holdLabel?: string;
  resumeLabel?: string;
}

/* The primary button of a screen that moves on by itself. The bar is driven
   from ticks rather than a CSS animation, which the reduced-motion rule would
   cut to nothing. Pause is there because content that moves on by itself
   needs a way to stop it (WCAG 2.2.2). */
export function AutoNext({ secs, label, onGo, restart, disabled = false, holdLabel = "Pause", resumeLabel = "Resume" }: Props){
  const now = useNow();
  const total = secs * 1000;
  const [held, setHeld] = useState(false);
  const [deadline, setDeadline] = useState(() => Date.now() + total);
  const [heldLeft, setHeldLeft] = useState(total);
  const fired = useRef(false);
  const go = useRef(onGo);
  go.current = onGo;
  const running = !held && !disabled;

  useEffect(() => { setDeadline(Date.now() + total); setHeldLeft(total); }, [restart, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return;
    const id = window.setTimeout(() => {
      if (fired.current) return;
      fired.current = true;
      go.current(true);
    }, Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(id);
  }, [running, deadline]);

  const tap = () => {
    if (fired.current) return;
    fired.current = true;
    onGo(false);
  };
  const toggle = () => {
    if (held){ setDeadline(Date.now() + heldLeft); setHeld(false); }
    else { setHeldLeft(Math.max(0, deadline - Date.now())); setHeld(true); }
  };

  const left = held ? heldLeft : Math.max(0, deadline - now);
  return (
    <div className={s.wrap}>
      <button type="button" className={`btn btn-primary btn-block ${s.btn}`} onClick={tap} disabled={disabled}>
        <span className={s.label}>{label}</span>
        {running && <span className={s.count} aria-hidden>{Math.ceil(left / 1000)}</span>}
        {!disabled && <span className={`${s.fill} ${held ? s.fillHeld : ""}`} style={{ transform: `scaleX(${left / total})` }} aria-hidden />}
      </button>
      {!disabled && (
        <button type="button" className={`link ${s.hold}`} onClick={toggle}>
          {held ? <><Play size={14} strokeWidth={2.75} /> {resumeLabel}</> : <><Pause size={14} strokeWidth={2.75} /> {holdLabel}</>}
        </button>
      )}
    </div>
  );
}
