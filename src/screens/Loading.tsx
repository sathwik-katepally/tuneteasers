import { Reel } from "../components/Reel";
import { DIFFICULTY } from "../lib/config";
import type { Settings } from "../types";
import s from "./Loading.module.css";
import sh from "./shared.module.css";

const LANG = { bolly: "Hindi", telugu: "Telugu", both: "Hindi and Telugu" } as const;

export function Loading({ settings }: { settings: Settings }){
  const eras = settings.eras.length === 1 ? `${settings.eras[0]} songs` : "songs from every era";
  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        <Reel size={110} className={s.reel} />
        <div>
          <h2 className={s.title}>Spooling the reel</h2>
          <p className={sh.muted}>{LANG[settings.mix]} {eras}, {DIFFICULTY[settings.difficulty].label.toLowerCase()} pick.</p>
        </div>
        <div className={s.strip} role="progressbar" aria-label="Loading songs"><div className={s.fill} /></div>
      </div>
    </div>
  );
}
