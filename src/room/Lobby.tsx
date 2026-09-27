import { X } from "lucide-react";
import { BulbFrame } from "../components/Bulbs";
import { Qr } from "../components/Qr";
import { DIFFICULTY, ROOM_SONGS_PER_ROUND } from "../lib/config";
import { roomLink, type Link, type RoomView } from "../lib/room";
import type { Settings } from "../types";
import sh from "../screens/shared.module.css";
import s from "./Lobby.module.css";

const LANG = { bolly: "Hindi", telugu: "Telugu", both: "Hindi and Telugu" } as const;
const siteAddress = () => (location.host + location.pathname).replace(/\/(index\.html)?$/, "");

export function Lobby({ code, view, link, settings, error, onStart, onKick, onBack }: {
  code: string; view: RoomView | null; link: Link; settings: Settings; error: string;
  onStart: () => void; onKick: (id: string) => void; onBack: () => void;
}){
  const players = view?.players ?? [];
  const ready = link === "open" && players.length > 0;
  return (
    <div className={sh.stage}>
      {error && <div className={s.error} role="alert">{error}</div>}
      <div className={s.board}>
        <BulbFrame mode="chase" gap={22} inset={7} size={8} />
        <span className={s.eyebrow}>Room code</span>
        <div className={s.letters} aria-label={`Room code ${code.split("").join(" ")}`}>
          {code.split("").map((c, i) => <span key={i} className={s.letter}>{c}</span>)}
        </div>
        <span className={s.status}>{link === "open" ? "Doors open" : link === "gone" ? "Room closed" : "Opening the doors"}</span>
      </div>

      <div className={s.join}>
        <Qr text={roomLink(code)} className={s.qr} label="QR code to join this room" />
        <p className={s.how}>
          Scan it with your phone camera, or open <b>{siteAddress()}</b> and type the code.
          This screen plays the songs; your phone is the buzzer.
        </p>
      </div>

      <div className={`${sh.paper} ${s.house}`}>
        <div className={s.houseHead}>
          <h2 className={s.houseTitle}>In the house</h2>
          <span className={s.count}>{players.length ? `${players.length} in` : "Empty"}</span>
        </div>
        {players.length ? (
          <div className={s.chips}>
            {players.map(p => (
              <span key={p.id} className={`${s.chip} ${p.online ? "" : s.chipAway}`}>
                <span className={s.chipName}>{p.name}</span>
                <button type="button" className={s.chipX} aria-label={`Remove ${p.name}`} onClick={() => onKick(p.id)}>
                  <X size={14} strokeWidth={3} />
                </button>
              </span>
            ))}
          </div>
        ) : <p className={s.empty}>Waiting for the first phone.</p>}
      </div>

      <div className={sh.actions}>
        <div className={`${s.foot} ${sh.muted}`}>
          <span>{LANG[settings.mix]}, {DIFFICULTY[settings.difficulty].label}</span>
          <span>{settings.rounds} rounds of {ROOM_SONGS_PER_ROUND} songs</span>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onStart} disabled={!ready}>
          {players.length ? "Start the show" : "Waiting for players"}
        </button>
        <button type="button" className={`link ${s.back}`} onClick={onBack}>Close the room</button>
      </div>
    </div>
  );
}

export function RoomTrouble({ gone, onBack, onRetry }: { gone: boolean; onBack: () => void; onRetry: () => void }){
  return (
    <div className={sh.stage}>
      <div className={s.trouble}>
        <span className={s.eyebrow}>{gone ? "Room closed" : "No room"}</span>
        <h2 className={s.troubleTitle}>{gone ? "This room has closed" : "Couldn't open a room"}</h2>
        <p className={s.how}>{gone ? "Rooms close after a few quiet hours. Open a new one and share its code." : "Buzz-in shows need a connection. Check it and try again, or pass one phone around instead."}</p>
      </div>
      <div className={sh.actions}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-ghost" onClick={onBack}>Home</button>
          <button type="button" className="btn btn-primary" onClick={onRetry}>New room</button>
        </div>
      </div>
    </div>
  );
}
