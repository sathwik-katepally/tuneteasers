import { engine } from "./engine.js";
import { hookOffset, ladderFor } from "./config";
import type { Track } from "../types";

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
