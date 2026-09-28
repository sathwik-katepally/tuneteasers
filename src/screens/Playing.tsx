import { useEffect, useState } from "react";
import { Lightbulb, Play, Plus, RotateCcw } from "lucide-react";
import { Equalizer } from "../components/Equalizer";
import { HINT_PENALTY, SPEED_BONUS_MAX, ladderFor, pointsNow } from "../lib/config";
import type { Phase, Track, Turn } from "../types";
import s from "./Playing.module.css";
import sh from "./shared.module.css";

interface Props {
  name: string;
  track: Track;
  plain: boolean;
  phase: Phase;
  turn: Turn;
  note: string;
  onPlay: (rung: number, replay?: boolean) => void;
  onJudge: (result: "correct" | "wrong") => void;
  onHint: () => void;
  onSkip: () => void;
}

const LINE: Partial<Record<Phase, string>> = { cueing: "Threading the film", playing: "Now playing", listened: "Clip over" };

export function Playing({ name, track, plain, phase, turn, note, onPlay, onJudge, onHint, onSkip }: Props){
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const playing = phase === "playing";
  const cueing = phase === "cueing";
  const ladder = ladderFor(plain);
  const { from, to } = turn.span;
  const left = Math.max(0, Math.ceil(to - from - (now - turn.clipStartedAt) / 1000));
  const worth = pointsNow(ladder, turn.rung, turn.clipEndedAt, turn.hint, now);
  const nextLen = turn.rung < ladder.last ? ladder.segments[turn.rung + 1] : null;
  const state = cueing ? "Loading" : playing ? `${left}s left` : phase === "blocked" ? "Paused" : "Guess, or hear more";
  const inSpan = (i: number) => i <= turn.rung && ladder.start(i) >= from;

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
        <div className={s.strip} style={{ gridTemplateColumns: ladder.segments.map(sec => `${sec}fr`).join(" ") }}>
          {ladder.segments.map((sec, i) => {
            const heard = i < turn.rung || (i === turn.rung && !cueing);
            const running = playing && inSpan(i);
            return (
              <div key={i} className={`${s.frame} ${heard && !running && !(cueing && inSpan(i)) ? s.frameDone : ""} ${i === turn.rung ? s.frameNow : ""} ${running ? s.frameLit : ""}`}>
                {running && (
                  <div key={turn.playKey} className={`${s.frameFill} ${s.frameRun}`}
                    style={{ animationDuration: `${sec}s`, animationDelay: `${ladder.start(i) - from}s` }} />
                )}
                <span className={s.frameText}>{i ? "+" : ""}{sec}s · {ladder.points[i]}</span>
              </div>
            );
          })}
        </div>
        <p className={s.caption}>No rush. A quick answer adds up to {SPEED_BONUS_MAX}.</p>
      </div>

      <div className={`${sh.actions} ${s.actions}`}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-cream" onClick={() => nextLen && onPlay(turn.rung + 1)} disabled={!nextLen || cueing}>
            <Plus size={18} strokeWidth={3} /> {nextLen ? `Hear ${nextLen}s more` : "Full clip"}
          </button>
          <button type="button" className="btn btn-cream" onClick={() => onPlay(turn.rung, true)} disabled={cueing || playing}>
            <RotateCcw size={17} strokeWidth={2.75} /> Replay
          </button>
        </div>
        <p className={s.guessPrompt}>Say the song or film out loud, then choose.</p>
        <div className={`${sh.row2} ${s.judgments}`}>
          <button type="button" className="btn btn-primary" onClick={() => onJudge("correct")} disabled={cueing}><span className={s.judgment}><span>I know</span> <span>this one</span></span></button>
          <button type="button" className="btn btn-cream" onClick={() => onJudge("wrong")} disabled={cueing}><span className={s.judgment}><span>I don't know</span> <span>this one</span></span></button>
        </div>
        <div className={s.links}>
          <button type="button" className={s.link} onClick={onHint} disabled={turn.hint}>
            <Lightbulb size={15} strokeWidth={2.5} /> {turn.hint ? "Hint shown" : `Hint, costs ${HINT_PENALTY}`}
          </button>
          {note.includes("Skip it") && <button type="button" className={s.link} onClick={onSkip}>Skip this song</button>}
        </div>
      </div>
    </div>
  );
}
