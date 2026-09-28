import { useEffect, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { Theatre, type MenuItem } from "./Theatre";
import type { GameState } from "../types";

/* The theatre plus the cross-fade between screens. Each owner (the
   pass-the-phone App, a room's host screen, a phone in a room) keys its
   current screen and hands it in here. */
export function Stage({ screenKey, meta, game, onHome, onEnd, onAbout, menu, aside, wide, onShown, children }: {
  screenKey: string; meta: string; game: GameState | null; onHome: () => void; onEnd: () => void; onAbout?: () => void;
  menu?: MenuItem[]; aside?: ReactNode; wide?: boolean; onShown?: () => void; children: ReactNode;
}){
  useEffect(() => { window.scrollTo(0, 0); }, [screenKey]);
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <Theatre meta={meta} game={game} onHome={onHome} onEnd={onEnd} onAbout={onAbout} menu={menu} aside={aside} wide={wide}>
          <AnimatePresence mode="wait" initial={false}>
            <m.div key={screenKey} className="screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}
              onAnimationComplete={onShown}>
              {children}
            </m.div>
          </AnimatePresence>
        </Theatre>
      </MotionConfig>
    </LazyMotion>
  );
}
