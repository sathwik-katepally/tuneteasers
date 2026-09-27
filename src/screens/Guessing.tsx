import * as m from "motion/react-m";
import { Eye } from "lucide-react";
import { HINT_PENALTY } from "../lib/config";
import type { Turn } from "../types";
import s from "./Guessing.module.css";
import sh from "./shared.module.css";

export function Guessing({ name, turn, onShow }: { name: string; turn: Turn; onShow: () => void }){
  return (
    <div className={sh.stage}>
      <div className={s.wrap}>
        <span className={s.who}>{name}, go on</span>
        <m.h2 className={s.title} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          Say it <em>out loud</em>
        </m.h2>
        <p className={s.sub}>The song or the film, whatever you can name. Then check the answer together.</p>
        <m.div className={s.worth} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 400, damping: 22, delay: 0.3 }}>
          Locked in at <span className={s.worthNum}>{turn.locked}</span>
        </m.div>
        {turn.hint && <p className={s.small}>Hint taken, {HINT_PENALTY} off.</p>}
      </div>
      <div className={sh.actions}>
        <button type="button" className="btn btn-primary btn-block" onClick={onShow}>
          <Eye size={20} strokeWidth={2.5} /> Show the answer
        </button>
      </div>
    </div>
  );
}
