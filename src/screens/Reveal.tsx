import { useEffect, useState } from "react";
import * as m from "motion/react-m";
import { useReducedMotion } from "motion/react";
import { Ban } from "lucide-react";
import { Curtain } from "../components/Curtain";
import { Stamp } from "../components/Stamp";
import { displayTitle } from "../lib/utils.js";
import type { Track, Verdict } from "../types";
import s from "./Reveal.module.css";
import sh from "./shared.module.css";

interface Props {
  track: Track;
  name: string;
  verdict: Verdict;
  note: string;
  onNext: () => void;
  primaryArtist: string;
  artistBlocked: boolean;
  onBlockArtist: () => void;
}

export function Reveal({ track, name, verdict, note, onNext, primaryArtist, artistBlocked, onBlockArtist }: Props){
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setOpen(true), reduce ? 50 : 350);
    return () => window.clearTimeout(timer);
  }, [reduce]);

  const correct = verdict?.result === "correct";
  const wrong = verdict?.result === "wrong";
  const film = track.album || "";
  const title = displayTitle(track.title);
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
            : <div className={`${s.art} ${s.noArt}`} aria-hidden>{(film || title).slice(0, 1)}</div>}
          <h2 className={`${s.title} ${title.length > 22 ? s.titleLong : ""}`}>{title}</h2>
          {(film || track.year > 0) && <p className={s.film}>{[film, track.year || ""].filter(Boolean).join(", ")}</p>}
          <p className={s.credits}>
            Sung by {track.artist}
            {track.music && <><br />Music by {track.music}</>}
          </p>
        </div>
        <Curtain open={open} />
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
      </div>
    </div>
  );
}
