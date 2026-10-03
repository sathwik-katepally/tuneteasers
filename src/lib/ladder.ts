import { useRef, useState } from "react";
import { engine } from "./engine.js";
import { log } from "./log.js";
import { hookOffset, ladderFor } from "./config";
import type { Track, Turn } from "../types";

export type ClipCallbacks = { onStart?: () => void; onEnd?: () => void; onErr?: () => void; onBlocked?: () => void };
export type ClipResult = "snip" | "plain" | "failed" | "superseded";

/* Play one rung of the clip ladder. Easy's window starts at the song's likely
   hook, Music-only's at its verified interval. "Hear more" picks up where the
   previous rung stopped; a replay starts from the top of the window. onStart
   fires once audio is actually flowing. Callers treat "superseded" as "do
   nothing" and "failed" as "this clip can't play" (onErr is not called). */
export async function playRung(track: Track, plain: boolean, rung: number, replay: boolean, cb: ClipCallbacks): Promise<ClipResult> {
  const { from, to } = ladderFor(plain).span(rung, replay);
  if (plain){
    engine.playElement(track.stream, hookOffset(track) + from, to - from, cb);
    return "plain";
  }
  return engine.playSnippet(track, from, to - from, cb) as Promise<ClipResult>;
}

/* What the clip is doing, as the owner's screen shows it. */
export type ClipStatus = "cueing" | "playing" | "listened" | "blocked";

export const freshTurn = (): Turn => ({ rung: 0, span: { from: 0, to: 0 }, clipEndedAt: null, clipStartedAt: 0, playKey: 0, hints: 0, cut: false });

interface ClipOwner {
  track: Track | null;
  plain: boolean;
  /* Each status change, into the owner's own screen state; the owner decides
     what a "playing" may not override (a tap prompt, a steal in progress). */
  setStatus: (s: ClipStatus) => void;
  /* Audio is flowing for this rung (the room opens buzzing). */
  onStarted?: (rung: number) => void;
  /* The clip stopped at its end (the room opens its grace window). A stream
     that failed does not count as ended. */
  onEnded?: () => void;
}

/* The turn record and the play sequence that pass-the-phone and the room host
   share: the span a rung covers, the started/ended/failed bookkeeping and the
   stream-error note. Timers and the engine's callbacks call `play` long after
   the render that made it, so the owner's latest values are read through a ref. */
export function useClipPlayer(owner: ClipOwner){
  const [turn, setTurn] = useState<Turn>(freshTurn);
  const [note, setNote] = useState("");
  const live = useRef(owner);
  live.current = owner;

  async function play(rung: number, replay = false){
    const { track, plain, setStatus, onStarted, onEnded } = live.current;
    if (!track) return;
    engine.ac();
    const span = ladderFor(plain).span(rung, replay);
    setNote("");
    setTurn(t => ({ ...t, rung, span, clipEndedAt: replay ? t.clipEndedAt : null, cut: false }));
    const started = () => {
      setTurn(t => ({ ...t, clipStartedAt: Date.now(), playKey: t.playKey + 1 }));
      setStatus("playing");
      onStarted?.(rung);
    };
    const ended = () => {
      setTurn(t => ({ ...t, clipEndedAt: t.clipEndedAt ?? Date.now() }));
      setStatus("listened");
    };
    const failed = () => {
      setNote(plain ? "This song won't stream right now. Skip it to try another." : "This music-only clip isn't available. Skip it to try another.");
      ended();
    };
    log("snippet", { rung, from: span.from, to: span.to, sound: plain ? "full" : "inst", title: String(track.title).slice(0, 28) });
    setStatus("cueing");
    const r = await playRung(track, plain, rung, replay, { onStart: started, onEnd: () => { ended(); onEnded?.(); }, onErr: failed, onBlocked: () => setStatus("blocked") });
    if (r === "failed") failed();
  }

  const reset = () => { setTurn(freshTurn()); setNote(""); };
  return { turn, setTurn, note, setNote, play, reset };
}
