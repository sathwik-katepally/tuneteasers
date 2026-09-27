import { useEffect, useState } from "react";
import { Lightbulb, Play, Plus, RotateCcw } from "lucide-react";
import { Equalizer } from "../components/Equalizer";
import { CLIP_POINTS, CLIP_STEPS, HINT_PENALTY, SPEED_BONUS_MAX, pointsNow } from "../lib/config";
import type { Phase, Track, Turn } from "../types";
import s from "./Playing.module.css";
import sh from "./shared.module.css";

interface Props {
  name: string;
  track: Track;
  phase: Phase;
  turn: Turn;
  note: string;
  onPlay: (rung: number, replay?: boolean) => void;
  onKnow: () => void;
  onHint: () => void;
  onSkip: () => void;
}

const LINE: Partial<Record<Phase, string>> = { cueing: "Threading the film", playing: "Now playing", listened: "Clip over" };

export function Playing({ name, track, phase, turn, note, onPlay, onKnow, onHint, onSkip }: Props){
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const playing = phase === "playing";
  const cueing = phase === "cueing";
  const secs = CLIP_STEPS[turn.rung];
  const left = Math.max(0, Math.ceil(secs - (now - turn.clipStartedAt) / 1000));
  const worth = pointsNow(turn.rung, turn.clipEndedAt, turn.hint, now);
  const nextLen = turn.rung < CLIP_STEPS.length - 1 ? CLIP_STEPS[turn.rung + 1] : null;
  const state = cueing ? "Loading" : playing ? `${left}s left` : phase === "blocked" ? "Paused" : "Guess, or hear more";

  return (
    <div className={sh.stage}>
      <div className={s.top}>
        <span className={s.who}>{name} is guessing</span>
        <span className={s.worth} aria-live="off">Worth <span className={s.worthNum}>{worth}</span></span>
      </div>

      <div className={s.screen}>
        <div className={s.pelmet} />
        <div className={s.poster}>
          {phase === "blocked" ? (
            <button type="button" className="btn btn-primary" onClick={() => onPlay(turn.rung, true)}>
              <Play size={18} strokeWidth={3} /> Tap to play
            </button>
          ) : <>
            <div className={`${s.mark} ${playing ? s.markOn : ""}`}>?</div>
            <span className={s.posterLine}>{LINE[phase]}</span>
          </>}
          {note && <p className={s.note}>{note}</p>}
          {turn.hint && (
            <p className={s.hintShown}>
              {track.album ? <>From <b>{track.album}</b></> : "No film on record"}{track.year ? `, ${track.year}` : ""}
            </p>
          )}
        </div>
        <Equalizer on={playing} />
      </div>

      <div className={s.ladder}>
        <div className={s.ladderHead}>
          <span className={s.ladderLabel}>Clip length</span>
          <span className={s.ladderState}>{state}</span>
        </div>
        <div className={s.strip}>
          {CLIP_STEPS.map((sec, i) => {
            const done = i < turn.rung;
            const cur = i === turn.rung;
            return (
              <div key={sec} className={`${s.frame} ${done ? s.frameDone : ""} ${cur ? s.frameNow : ""}`}>
                {cur && !cueing && (
                  <div key={turn.playKey} className={`${s.frameFill} ${playing ? s.frameRun : ""}`} style={{ animationDuration: `${sec}s` }} />
                )}
                <span className={s.frameText}>{sec}s · {CLIP_POINTS[i]}</span>
              </div>
            );
          })}
        </div>
        <p className={s.caption}>No rush. A quick answer adds up to {SPEED_BONUS_MAX}.</p>
      </div>

      <div className={sh.actions}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-cream" onClick={() => nextLen && onPlay(turn.rung + 1)} disabled={!nextLen || cueing}>
            <Plus size={18} strokeWidth={3} /> {nextLen ? `Hear ${nextLen}s` : "Full clip"}
          </button>
          <button type="button" className="btn btn-cream" onClick={() => onPlay(turn.rung, true)} disabled={cueing || playing}>
            <RotateCcw size={17} strokeWidth={2.75} /> Replay
          </button>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onKnow} disabled={cueing}>I know this one</button>
        <div className={s.links}>
          <button type="button" className={s.link} onClick={onHint} disabled={turn.hint}>
            <Lightbulb size={15} strokeWidth={2.5} /> {turn.hint ? "Hint shown" : `Hint, costs ${HINT_PENALTY}`}
          </button>
          <button type="button" className={s.link} onClick={onSkip}>Skip this song</button>
        </div>
      </div>
    </div>
  );
}
