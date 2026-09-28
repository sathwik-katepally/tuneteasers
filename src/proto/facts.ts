import { CLIP_POINTS, CLIP_SEGMENTS, DIFFICULTY } from "../lib/config";

export interface LandingProps { onStart: () => void; onJoin: () => void }

export const FIRST_CLIP = CLIP_SEGMENTS[0];
export const LADDER = CLIP_SEGMENTS.map((secs, i) => ({ secs, points: CLIP_POINTS[i], label: i === 0 ? `${secs}s` : `+${secs}s` }));

const levels = (sound: "full" | "inst") => Object.values(DIFFICULTY).filter(d => d.sound === sound).map(d => d.label);
const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export const SOUND_LINE = `${and(levels("full"))} keeps the singing in; ${and(levels("inst"))} ${levels("inst").length > 1 ? "are" : "is"} music only.`;
