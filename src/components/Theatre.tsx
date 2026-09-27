import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { BulbRow } from "./Bulbs";
import type { GameState } from "../types";
import s from "./Theatre.module.css";

interface Props {
  meta: string;
  game: GameState | null;
  onHome: () => void;
  onEnd: () => void;
  children: ReactNode;
}

/* The single-screen cinema around every screen: bulb marquee on top, and on
   wide screens red curtains either side of the stage and seat backs below. */
export function Theatre({ meta, game, onHome, onEnd, children }: Props){
  return (
    <div className={s.theatre}>
      <header className={s.marquee}>
        <BulbRow className={s.bulbsTop} gap={26} size={7} />
        <div className={s.marqueeInner}>
          <h1 className={s.title}>Tune Teasers</h1>
          <div className={s.marqueeMeta}>{meta}</div>
          {game && <GameMenu game={game} onHome={onHome} onEnd={onEnd} />}
        </div>
        <BulbRow className={s.bulbsBottom} gap={26} size={7} />
      </header>
      <div className={s.house}>
        <aside className={s.curtain} aria-hidden />
        <main className={s.stage}>{children}</main>
        <aside className={s.curtain} aria-hidden />
      </div>
      <div className={s.seats} aria-hidden />
    </div>
  );
}

function GameMenu({ game, onHome, onEnd }: { game: GameState; onHome: () => void; onEnd: () => void }){
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const ranked = [...game.cast].sort((a, b) => b.score - a.score);
  const toggle = () => { setOpen(o => !o); setConfirming(false); };
  return (
    <div className={s.menuWrap} ref={ref}>
      <button type="button" className={s.menuBtn} aria-label={open ? "Close menu" : "Game menu"} aria-expanded={open} onClick={toggle}>
        {open ? <X size={18} strokeWidth={2.5} /> : <Menu size={18} strokeWidth={2.5} />}
      </button>
      {open && (
        <div className={s.menu} role="dialog" aria-label="Game menu">
          <div className={s.menuHead}>Standings</div>
          <ol className={s.standings}>
            {ranked.map(c => <li key={c.id}><span>{c.name}</span><b>{c.score}</b></li>)}
          </ol>
          {confirming ? (
            <div className={s.confirm}>
              <p>End this show? The scores go with it.</p>
              <div className={s.confirmRow}>
                <button type="button" className="btn btn-cream" onClick={() => setConfirming(false)}>Keep playing</button>
                <button type="button" className="btn btn-primary" onClick={() => { setOpen(false); onEnd(); }}>End it</button>
              </div>
            </div>
          ) : (
            <div className={s.menuActions}>
              <button type="button" className="btn btn-cream btn-block" onClick={() => { setOpen(false); onHome(); }}>Home, keep the game</button>
              <button type="button" className={s.endLink} onClick={() => setConfirming(true)}>End game</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
