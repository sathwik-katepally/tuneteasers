import { useEffect, useState } from "react";
import { Eye, Play, Plus } from "lucide-react";
import { Equalizer } from "../components/Equalizer";
import { CLIP_POINTS, CLIP_SEGMENTS, LAST_RUNG, ROOM_WRONG_BEAT_MS, rungStart } from "../lib/config";
import { playerName, type Link, type RoomSong, type RoomView } from "../lib/room";
import p from "../screens/Playing.module.css";
import sh from "../screens/shared.module.css";
import s from "./HostPlaying.module.css";

export type Audio = "cueing" | "playing" | "listened" | "blocked" | "paused";

interface Props {
  view: RoomView;
  song: RoomSong | null;
  songNo: number;
  total: number;
  clip: { rung: number; span: { from: number; to: number }; startedAt: number; key: number };
  audio: Audio;
  graceUntil: number | null;
  msLeft: number | null;
  note: string;
  wrong: { name: string; text: string; timeout: boolean; at: number } | null;
  link: Link;
  onPlay: () => void;
  onMore: () => void;
  onReveal: () => void;
  onSkip: () => void;
}

export function HostPlaying({ view, song, songNo, total, clip, audio, graceUntil, msLeft, note, wrong, link, onPlay, onMore, onReveal, onSkip }: Props){
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const state = song?.state ?? "cue";
  const playing = audio === "playing";
  const cueing = audio === "cueing";
  const answering = state === "answering";
  const who = playerName(view, song?.answering ?? null);
  const secsLeft = msLeft === null ? 0 : Math.ceil(msLeft / 1000);
  const graceLeft = graceUntil && state === "live" ? Math.max(0, Math.ceil((graceUntil - now) / 1000)) : null;
  const recentWrong = wrong && now - wrong.at < ROOM_WRONG_BEAT_MS + 700 ? wrong : null;
  const { from, to } = clip.span;
  const nextLen = clip.rung < LAST_RUNG ? CLIP_SEGMENTS[clip.rung + 1] : null;
  const clipLeft = Math.max(0, Math.ceil(to - from - (now - clip.startedAt) / 1000));
  const inSpan = (i: number) => i <= clip.rung && rungStart(i) >= from;
  const paused = answering || audio === "paused";
  const line = answering ? "" : state === "missed" ? "Nobody yet"
    : cueing ? "Threading the film" : playing ? "Buzz when you know it" : graceLeft !== null ? `Anyone? ${graceLeft}` : "";
  const ladderState = answering ? "Paused for an answer" : cueing ? "Loading" : playing ? `${clipLeft}s left` : state === "missed" ? "More coming" : "Buzzers open";
  const worth = song && song.rung >= 0 ? song.points : CLIP_POINTS[clip.rung];
  const queue = song?.queue ?? [];

  return (
    <div className={sh.stage}>
      <div className={p.top}>
        <span className={p.who}>Song {songNo} of {total}</span>
        <span className={p.worth}>Worth <span className={p.worthNum}>{worth}</span></span>
      </div>

      <div className={`${p.screen} ${s.screen}`}>
        <div className={p.pelmet} />
        <div className={p.poster}>
          {recentWrong && (
            <p className={s.wrong} key={recentWrong.at}>
              <b>{recentWrong.name}</b> {recentWrong.timeout ? "ran out of time" : <>said “{recentWrong.text}”</>} <span className={s.nope}>Not it</span>
            </p>
          )}
          {audio === "blocked" ? (
            <button type="button" className="btn btn-primary" onClick={onPlay}>
              <Play size={18} strokeWidth={3} /> Tap to play
            </button>
          ) : answering ? (
            <div className={s.answering}>
              <span className={s.onBuzzer}>On the buzzer</span>
              <h2 className={`${s.name} ${who.length > 10 ? s.nameLong : ""}`}>{who}</h2>
              <div className={s.clock} role="timer" aria-label={`${secsLeft} seconds to answer`}>
                <div className={s.clockFill} style={{ transform: `scaleX(${msLeft === null ? 0 : Math.min(1, msLeft / (view.answerSecs * 1000))})` }} />
                <span className={s.clockText}>{secsLeft}s to answer</span>
              </div>
              {queue.length > 1 && <p className={s.next}>Then {queue.slice(1).map(id => playerName(view, id)).join(", ")}</p>}
            </div>
          ) : <>
            <div className={`${p.mark} ${playing ? p.markOn : ""}`}>?</div>
            {graceLeft !== null && !cueing && !playing
              ? <span className={s.anyone}>Anyone? <b>{graceLeft}</b></span>
              : <span className={p.posterLine}>{line}</span>}
          </>}
          {note && <p className={p.note}>{note}</p>}
        </div>
        <Equalizer on={playing} />
      </div>

      <div className={p.ladder}>
        <div className={p.ladderHead}>
          <span className={p.ladderLabel}>Clip length</span>
          <span className={p.ladderState}>{ladderState}</span>
        </div>
        <div className={p.strip} style={{ gridTemplateColumns: CLIP_SEGMENTS.map(sec => `${sec}fr`).join(" ") }}>
          {CLIP_SEGMENTS.map((sec, i) => {
            const heard = i < clip.rung || (i === clip.rung && !cueing);
            const running = (playing || paused) && inSpan(i) && clip.startedAt > 0;
            return (
              <div key={i} className={`${p.frame} ${heard && !running && !(cueing && inSpan(i)) ? p.frameDone : ""} ${i === clip.rung ? p.frameNow : ""} ${running ? p.frameLit : ""}`}>
                {running && (
                  <div key={clip.key} className={`${p.frameFill} ${p.frameRun}`}
                    style={{ animationDuration: `${sec}s`, animationDelay: `${rungStart(i) - from}s`, animationPlayState: paused ? "paused" : undefined }} />
                )}
                <span className={p.frameText}>{i ? "+" : ""}{sec}s · {CLIP_POINTS[i]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={s.seats} aria-label="Players">
        {view.players.map(pl => {
          const at = queue.indexOf(pl.id);
          const out = song?.locked.includes(pl.id);
          const on = song?.answering === pl.id;
          return (
            <div key={pl.id} className={`${s.seat} ${on ? s.seatOn : ""} ${out ? s.seatOut : ""} ${pl.online ? "" : s.seatAway}`}>
              <span className={s.seatName}>{pl.name}</span>
              <span className={s.seatScore}>{at > 0 ? `#${at + 1}` : pl.score}</span>
            </div>
          );
        })}
      </div>

      <div className={`${sh.actions} ${p.actions}`}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-cream" onClick={onMore} disabled={answering || cueing || audio === "blocked"}>
            <Plus size={18} strokeWidth={3} /> {nextLen ? `Hear ${nextLen}s more` : "Play it again"}
          </button>
          <button type="button" className="btn btn-cream" onClick={onReveal} disabled={answering || cueing}>
            <Eye size={17} strokeWidth={2.75} /> Reveal it
          </button>
        </div>
        <p className={s.caption}>
          <span>{link === "open" ? <>Buzz on your phone. Room <b>{view.code}</b></> : "Reconnecting to the room"}</span>
          {note && <button type="button" className={`link ${s.skip}`} onClick={onSkip}>Skip this song</button>}
        </p>
      </div>
    </div>
  );
}
