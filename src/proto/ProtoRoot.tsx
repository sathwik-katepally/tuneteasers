import { useState, type ComponentType } from "react";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { App } from "../app";
import { Phone } from "../room/Phone";
import type { LandingProps } from "./facts";
import { LandingA } from "./LandingA";
import { LandingB } from "./LandingB";
import { LandingC } from "./LandingC";
import { LandingD } from "./LandingD";
import { Chooser } from "./Chooser";

export const OPTIONS: { id: string; name: string; idea: string; Landing: ComponentType<LandingProps> }[] = [
  { id: "a", name: "Marquee", idea: "The whole screen is the lit sign outside the hall, with the pitch spelled out on its letter board.", Landing: LandingA },
  { id: "b", name: "Admit one", idea: "Inside the usual theatre frame, a ticket whose printed fields explain the game; tearing the stub lets you in.", Landing: LandingB },
  { id: "c", name: "Curtain up", idea: "Closed curtains with a U-certificate card on them; the curtains rise to reveal the booking counter.", Landing: LandingC },
  { id: "d", name: "Poster", idea: "A hand-painted film poster: one big question, the points ladder at a glance, the button at thumb height.", Landing: LandingD },
];

/* Links that carry a room code or a group invite go straight into the app,
   exactly as they would without a landing page. */
const deepLink = () => /^#(room|join)=/.test(location.hash);

export function ProtoRoot({ id }: { id: string }){
  const option = OPTIONS.find(o => o.id === id);
  const [view, setView] = useState<"landing" | "app" | "join">(option && !deepLink() ? "landing" : "app");
  if (!option && id) return <App />;
  if (!option) return <Chooser options={OPTIONS} />;
  const { Landing } = option;
  return (
    <>
      {view === "join" ? <Phone code="" onExit={() => setView("app")} /> : view === "app" ? <App /> : null}
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <AnimatePresence>
            {view === "landing" && <Landing key="landing" onStart={() => setView("app")} onJoin={() => setView("join")} />}
          </AnimatePresence>
        </MotionConfig>
      </LazyMotion>
    </>
  );
}
