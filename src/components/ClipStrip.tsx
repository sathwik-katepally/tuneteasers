import { useEffect, useState, type ReactNode } from "react";
import type { Ladder } from "../lib/config";
import type { Turn } from "../types";
import s from "./ClipStrip.module.css";

/* The clock the clip screens count down on: the strip's "Ns left", the speed
   bonus and a room's grace window all read it. */
export function useNow(){
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

interface Props {
  ladder: Ladder;
  turn: Turn;
  cueing: boolean;
  playing: boolean;
  /* The clip stopped mid-way (a room's buzz), so the fill holds where it is. */
  paused?: boolean;
  /* What the strip says beside "Clip length". */
  state: string;
  children?: ReactNode;
}

/* The clip ladder as a film strip: one frame per rung with its length and
   points, the frames heard so far filled in, and the one playing filling up
   in step with the sound. */
export function ClipStrip({ ladder, turn, cueing, playing, paused = false, state, children }: Props){
  const { from } = turn.span;
  const inSpan = (i: number) => i <= turn.rung && ladder.start(i) >= from;
  return (
    <div className={s.ladder}>
      <div className={s.ladderHead}>
        <span className={s.ladderLabel}>Clip length</span>
        <span className={s.ladderState}>{state}</span>
      </div>
      <div className={s.strip} style={{ gridTemplateColumns: ladder.segments.map(sec => `${sec}fr`).join(" ") }}>
        {ladder.segments.map((sec, i) => {
          const heard = i < turn.rung || (i === turn.rung && !cueing);
          const running = (playing || paused) && inSpan(i) && turn.clipStartedAt > 0;
          return (
            <div key={i} className={`${s.frame} ${heard && !running && !(cueing && inSpan(i)) ? s.frameDone : ""} ${i === turn.rung ? s.frameNow : ""} ${running ? s.frameLit : ""}`}>
              {running && (
                <div key={turn.playKey} className={`${s.frameFill} ${s.frameRun}`}
                  style={{ animationDuration: `${sec}s`, animationDelay: `${ladder.start(i) - from}s`, animationPlayState: paused ? "paused" : undefined }} />
              )}
              <span className={s.frameText}>{i ? "+" : ""}{sec}s · {ladder.points[i]}</span>
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
