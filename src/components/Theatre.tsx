import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { BulbRow } from "./Bulbs";
import type { GameState } from "../types";
import s from "./Theatre.module.css";

export interface MenuItem { label: string; onClick: () => void }

interface Props {
  meta: string;
  game: GameState | null;
  onHome: () => void;
  onEnd: () => void;
  onAbout?: () => void;
  /* Home-screen menu entries; with none, the marquee shows a plain About button. */
  menu?: MenuItem[];
  /* Pinned beside the stage on wide screens, e.g. a room's join tag during play. */
  aside?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

/* The single-screen cinema around every screen: bulb marquee on top, and on
   wide screens red curtains either side of the stage and seat backs below. */
export function Theatre({ meta, game, onHome, onEnd, onAbout, menu, aside, wide, children }: Props){
  const items = menu?.length && onAbout ? [...menu, { label: "About the game", onClick: onAbout }] : menu ?? [];
  return (
    <div className={`${s.theatre} ${wide ? s.wide : ""}`}>
      <header className={s.marquee}>
        <BulbRow className={s.bulbsTop} gap={26} size={7} />
        <div className={s.marqueeInner}>
          <h1 className={s.title}>Tune Teasers</h1>
          <div className={s.marqueeMeta}>{meta}</div>
          {items.length ? <HomeMenu items={items} />
            : onAbout && <button type="button" className={s.aboutBtn} onClick={onAbout}>About</button>}
          {game && <GameMenu game={game} onHome={onHome} onEnd={onEnd} />}
        </div>
        <BulbRow className={s.bulbsBottom} gap={26} size={7} />
      </header>
      <div className={s.house}>
        <aside className={s.curtain} aria-hidden />
        <main className={s.stage}>{children}</main>
        <aside className={s.curtain} aria-hidden />
        {aside && <div className={s.aside}>{aside}</div>}
      </div>
      <div className={s.seats} aria-hidden />
    </div>
  );
}

/* A marquee dropdown that closes on a tap outside it or Escape. */
function useDropdown(){
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return { open, setOpen, ref };
}

function HomeMenu({ items }: { items: MenuItem[] }){
  const { open, setOpen, ref } = useDropdown();
  return (
    <div className={s.menuWrap} ref={ref}>
      <button type="button" className={s.menuBtn} aria-label={open ? "Close menu" : "Menu"} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {open ? <X size={18} strokeWidth={2.5} /> : <Menu size={18} strokeWidth={2.5} />}
      </button>
      {open && (
        <nav className={`${s.menu} ${s.homeMenu}`} aria-label="Menu">
          {items.map(it => (
            <button key={it.label} type="button" className={s.menuItem} onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </nav>
      )}
    </div>
  );
}

function GameMenu({ game, onHome, onEnd }: { game: GameState; onHome: () => void; onEnd: () => void }){
  const { open, setOpen, ref } = useDropdown();
  const [confirming, setConfirming] = useState(false);
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
