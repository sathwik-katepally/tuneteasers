import { useEffect, useState } from "react";
import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import { Ban, Check, X } from "lucide-react";
import { Curtain } from "../components/Curtain";
import { Stamp } from "../components/Stamp";
import type { Track, Verdict } from "../types";
import s from "./Reveal.module.css";
import sh from "./shared.module.css";

interface Props {
  track: Track;
  name: string;
  verdict: Verdict | null;
  worth: number;
  note: string;
  onJudge: (r: "correct" | "wrong") => void;
  onNext: () => void;
  primaryArtist: string;
  artistBlocked: boolean;
  onBlockArtist: () => void;
}

export function Reveal({ track, name, verdict, worth, note, onJudge, onNext, primaryArtist, artistBlocked, onBlockArtist }: Props){
  const reduce = useReducedMotion();
  const [stage, setStage] = useState<"closed" | "open" | "up">("closed");
  useEffect(() => {
    const a = window.setTimeout(() => setStage("open"), reduce ? 50 : 350);
    const b = window.setTimeout(() => setStage("up"), reduce ? 300 : 1500);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [reduce]);

  const correct = verdict?.result === "correct";
  const wrong = verdict?.result === "wrong";
  const film = track.album || "";
  return (
    <div className={sh.stage}>
      <m.div
        className={`${s.screen} ${wrong && !reduce ? s.flicker : ""}`}
        animate={correct && !reduce ? { x: [0, -6, 5, -3, 0], y: [0, 3, -2, 1, 0] } : {}}
        transition={{ duration: 0.35, delay: 0.1 }}
      >
        <div className={s.card}>
          <span className={s.starring}>Starring</span>
          {track.art
            ? <img className={s.art} src={track.art} alt={film ? `${film} cover` : "Album cover"} width={220} height={220} />
            : <div className={`${s.art} ${s.noArt}`} aria-hidden>{(film || track.title).slice(0, 1)}</div>}
          <h2 className={s.title}>{track.title}</h2>
          {(film || track.year > 0) && <p className={s.film}>{[film, track.year || ""].filter(Boolean).join(", ")}</p>}
          <p className={s.credits}>
            Sung by {track.artist}
            {track.music && <><br />Music by {track.music}</>}
          </p>
        </div>
        <Curtain open={stage !== "closed"} />
        {correct && <div className={s.stampWrap}><Stamp text="Housefull" sub="Every seat taken" /></div>}
        {wrong && !reduce && <div className={s.scratch} aria-hidden />}
        {wrong && (
          <div className={s.stampWrap}>
            <m.div className={s.torn} initial={{ opacity: 0, rotate: 6, y: 20 }} animate={{ opacity: 1, rotate: -4, y: 0 }}
              transition={{ delay: reduce ? 0 : 0.5, type: "spring", stiffness: 300, damping: 20 }}>
              <span className={s.tornBig}>Not this one</span>
              <span className={s.tornSmall}>Nothing for {name}</span>
            </m.div>
          </div>
        )}
      </m.div>

      <div className={sh.actions}>
        {note && <p className={s.note}>{note}</p>}
        {!verdict ? <>
          <p className={s.line}>Did {name} get it?</p>
          <div className={sh.row2}>
            <button type="button" className={s.missed} onClick={() => onJudge("wrong")} disabled={stage !== "up"}>
              <X size={20} strokeWidth={3} /> Missed
            </button>
            <button type="button" className="btn btn-teal" onClick={() => onJudge("correct")} disabled={stage !== "up"}>
              <Check size={20} strokeWidth={3} /> Got it +{worth}
            </button>
          </div>
        </> : <>
          <m.p className={s.line} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduce ? 0 : 0.4 }}>
            {correct ? `+${verdict.points} for ${name}, ${verdict.total} in total` : "Better luck next reel"}
          </m.p>
          <button type="button" className="btn btn-primary btn-block" onClick={onNext}>
            {verdict.finished ? "Final box office" : verdict.roundOver ? "To the box office" : "Pass it on"}
          </button>
          {primaryArtist && (
            <button type="button" className={s.block} onClick={onBlockArtist} disabled={artistBlocked}>
              {artistBlocked ? `${primaryArtist} won't come up again` : <><Ban size={14} strokeWidth={2.5} /> Don't play {primaryArtist} again</>}
            </button>
          )}
        </>}
      </div>
    </div>
  );
}
