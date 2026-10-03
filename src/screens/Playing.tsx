import { Lightbulb, Play, Plus, RotateCcw } from "lucide-react";
import { ClipStrip, useNow } from "../components/ClipStrip";
import { Equalizer } from "../components/Equalizer";
import { HINT_PENALTY, SPEED_BONUS_MAX, STEAL_SHARE, hintsFor, ladderFor, pointsNow } from "../lib/config";
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
  /* Someone else is guessing a song passed on to them, for part of its points. */
  stealing: boolean;
  /* Who a pass would go to; absent once it has been round the table. */
  passTo?: string;
  onPass: () => void;
  /* "Heard it too much": this contestant's skips left, and the skip itself
     (absent when no song of the same tier is left to replace this one). */
  skipsLeft: number;
  onHeardIt?: () => void;
}

const LINE: Partial<Record<Phase, string>> = { cueing: "Threading the film", playing: "Now playing", listened: "Clip over" };

export function Playing({ name, track, plain, phase, turn, note, onPlay, onJudge, onHint, onSkip, stealing, passTo, onPass, skipsLeft, onHeardIt }: Props){
  const now = useNow();
  const playing = phase === "playing";
  const cueing = phase === "cueing";
  const ladder = ladderFor(plain);
  const { from, to } = turn.span;
  const left = Math.max(0, Math.ceil(to - from - (now - turn.clipStartedAt) / 1000));
  const worth = pointsNow(ladder, turn.rung, turn.clipEndedAt, turn.hints, now, stealing);
  const hints = hintsFor(track);
  const shown = hints.slice(0, turn.hints);
  const nextLen = turn.rung < ladder.last ? ladder.segments[turn.rung + 1] : null;
  const state = cueing ? "Loading" : playing ? `${left}s left` : phase === "blocked" ? "Paused" : "Guess, or hear more";

  return (
    <div className={sh.stage}>
      <div className={s.top}>
        <span className={s.who}>{name} is {stealing ? "stealing" : "guessing"}</span>
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
            {!shown.length && <div className={`${s.mark} ${playing ? s.markOn : ""}`}>?</div>}
            <span className={s.posterLine}>{LINE[phase]}</span>
          </>}
          {note && <p className={s.note}>{note}</p>}
          {shown.length > 0 && <p className={s.hintShown}>{shown.map(h => <span key={h}>{h}</span>)}</p>}
        </div>
        <Equalizer on={playing} />
      </div>

      <ClipStrip ladder={ladder} turn={turn} cueing={cueing} playing={playing} state={state}>
        <p className={s.caption}>{stealing ? `A steal scores ${STEAL_SHARE === 0.5 ? "half" : `${STEAL_SHARE * 100}%`} of this.` : `No rush. A quick answer adds up to ${SPEED_BONUS_MAX}.`}</p>
      </ClipStrip>

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
          {passTo
            ? <button type="button" className="btn btn-cream" onClick={onPass} disabled={cueing}><span className={s.judgment}><span>Pass to</span> <span>{passTo}</span></span></button>
            : <button type="button" className="btn btn-cream" onClick={() => onJudge("wrong")} disabled={cueing}><span className={s.judgment}><span>I don't know</span> <span>this one</span></span></button>}
        </div>
        <div className={s.links}>
          <button type="button" className={s.link} onClick={onHint} disabled={turn.hints >= hints.length}>
            <Lightbulb size={15} strokeWidth={2.5} /> {turn.hints >= hints.length ? "No more hints" : `Hint ${turn.hints + 1} of ${hints.length}, costs ${HINT_PENALTY}`}
          </button>
          {note.includes("Skip it") ? <button type="button" className={s.link} onClick={onSkip}>Skip this song</button>
            : stealing ? passTo && <button type="button" className={s.link} onClick={() => onJudge("wrong")} disabled={cueing}>Nobody knows it</button>
            : (onHeardIt || !skipsLeft) && (
              <button type="button" className={`${s.link} ${s.heard}`} onClick={onHeardIt} disabled={!skipsLeft || cueing}>
                <span className={s.heardText}>Heard it<span className={s.heardMore}> too much</span></span> <span className={s.stub}>{skipsLeft ? `${skipsLeft} left` : "Used"}</span>
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
