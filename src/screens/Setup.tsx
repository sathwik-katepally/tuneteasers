import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ERAS } from "../lib/constants.js";
import { DIFFICULTY, MAX_CAST, MAX_MEMBERS, NAME_MAX, ROOM_SONGS_PER_ROUND, ROUND_OPTIONS } from "../lib/config";
import { cleanName, newId } from "../lib/save";
import { Seg } from "../components/Seg";
import { GroupPanel } from "../components/GroupPanel";
import { CategoryPicker } from "../components/CategoryPicker";
import type { HostShow } from "../lib/room";
import type { Difficulty, GameState, Mix, Mode, Play, RosterEntry, Settings } from "../types";
import sh from "./shared.module.css";
import s from "./Setup.module.css";

interface Props {
  error: string;
  settings: Settings;
  upSettings: (patch: Partial<Settings>) => void;
  players: RosterEntry[];
  teams: RosterEntry[];
  setRoster: (mode: Mode, list: RosterEntry[]) => void;
  blocked: string[];
  unblockArtist: (name: string) => void;
  startGame: () => void;
  savedGame: GameState | null;
  resumeGame: () => void;
  discardGame: () => void;
  invite: string;
  clearInvite: () => void;
  showPastGames: () => void;
  hostShow: HostShow | null;
  openRoom: () => void;
  resumeRoom: () => void;
  discardRoom: () => void;
  joinRoom: () => void;
}

const ERA_ALL = "all";
const MIN_CAST: Record<Mode, number> = { players: 1, teams: 2 };

export function Setup(p: Props){
  const { settings: S, upSettings } = p;
  const mode = S.mode;
  const list = mode === "teams" ? p.teams : p.players;
  const setList = (l: RosterEntry[]) => p.setRoster(mode, l);
  const era = S.eras.length === 1 ? S.eras[0] : ERA_ALL;
  const room = S.play === "room";
  const canStart = room || list.length >= MIN_CAST[mode];

  const add = (name: string) => setList([...list, { id: newId(), name, members: [] }]);
  const rename = (id: string, name: string) => setList(list.map(e => (e.id === id ? { ...e, name } : e)));
  const remove = (id: string) => setList(list.filter(e => e.id !== id));
  const setMembers = (id: string, members: string[]) => setList(list.map(e => (e.id === id ? { ...e, members } : e)));

  return (
    <div className={sh.stage}>
      {p.error && <div className={s.error} role="alert">{p.error}</div>}
      {p.invite && <GroupPanel invite={p.invite} clearInvite={p.clearInvite} showPastGames={p.showPastGames} />}
      {p.savedGame && <ResumeCard game={p.savedGame} onResume={p.resumeGame} onDiscard={p.discardGame} />}
      {p.hostShow && <RoomResumeCard show={p.hostShow} onResume={p.resumeRoom} onDiscard={p.discardRoom} />}
      <div className={s.joinStrip}>
        <span className={s.joinText}>Someone else hosting a buzz-in show?</span>
        <button type="button" className={`btn btn-teal ${s.joinBtn}`} onClick={p.joinRoom}>Join with a code</button>
      </div>

      <div className={sh.paper}>
        <div className={s.head}>
          <h2 className={s.headTitle}>Tonight's show</h2>
          <span className={s.headMeta}>Booking counter</span>
        </div>

        <div className={s.group}>
          <span className={s.labelText}>How you play</span>
          <Seg<Play> label="How you play" tone="teal" value={S.play}
            options={[{ value: "pass", label: "Pass the phone" }, { value: "room", label: "Buzz in" }]}
            onChange={v => upSettings({ play: v })} />
          <p className={s.hint}>{room
            ? "This screen plays the songs. Everyone joins on their own phone and buzzes in; first to buzz answers."
            : "One phone goes round the room, one song per turn."}</p>
        </div>

        {!room && (
          <div className={s.group}>
            <div className={s.label}>
              <span className={s.labelText}>{mode === "teams" ? "Teams" : "Who's in"}</span>
              <div className={s.modeSeg}>
                <Seg<Mode> label="Play as" tone="teal" value={mode}
                  options={[{ value: "players", label: "Solo" }, { value: "teams", label: "Teams" }]}
                  onChange={v => upSettings({ mode: v })} />
              </div>
            </div>
            {mode === "players" ? (
              <div className={s.chips}>
                {list.map(e => (
                  <NameChip key={e.id} name={e.name} canRemove={list.length > MIN_CAST.players}
                    onRename={n => rename(e.id, n)} onRemove={() => remove(e.id)} />
                ))}
                {list.length < MAX_CAST && <AddChip label="Add" placeholder="Name" onAdd={add} />}
              </div>
            ) : (
              <div className={s.teams}>
                {list.map(e => (
                  <div key={e.id} className={s.team}>
                    <NameChip name={e.name} canRemove={list.length > MIN_CAST.teams} strong
                      onRename={n => rename(e.id, n)} onRemove={() => remove(e.id)} />
                    <div className={s.members}>
                      {e.members.map((mName, i) => (
                        <NameChip key={i} name={mName} small canRemove
                          onRename={n => setMembers(e.id, e.members.map((x, j) => (j === i ? n : x)))}
                          onRemove={() => setMembers(e.id, e.members.filter((_, j) => j !== i))} />
                      ))}
                      {e.members.length < MAX_MEMBERS && (
                        <AddChip small label="Member" placeholder="Name" onAdd={n => setMembers(e.id, [...e.members, n])} />
                      )}
                    </div>
                  </div>
                ))}
                {list.length < MAX_CAST && <AddChip label="Add team" placeholder="Team name" onAdd={add} />}
                <p className={s.hint}>Members are optional. Add them and the phone rotates through each team.</p>
              </div>
            )}
          </div>
        )}

        <div className={s.group}>
          <span className={s.labelText}>Songs from</span>
          <Seg<Mix> label="Language" value={S.mix}
            options={[{ value: "bolly", label: "Hindi" }, { value: "telugu", label: "Telugu" }, { value: "both", label: "Both" }]}
            onChange={v => upSettings({ mix: v })} />
        </div>

        <div className={s.group}>
          <span className={s.labelText}>Era</span>
          <Seg<string> label="Era" value={era}
            options={[...ERAS.map((e: string) => ({ value: e, label: e })), { value: ERA_ALL, label: "All" }]}
            onChange={v => upSettings({ eras: v === ERA_ALL ? [...ERAS] : [v] })} />
        </div>

        <div className={s.group}>
          <span className={s.labelText}>How hard</span>
          <Seg<Difficulty> label="Difficulty" value={S.difficulty}
            options={(Object.keys(DIFFICULTY) as Difficulty[]).map(d => ({ value: d, label: DIFFICULTY[d].label }))}
            onChange={v => upSettings({ difficulty: v })} />
          <p className={s.hint}>{DIFFICULTY[S.difficulty].note}</p>
        </div>

        <div className={s.group}>
          <span className={s.labelText}>Kind of songs</span>
          <CategoryPicker settings={S} need={S.rounds * list.length} blocked={p.blocked} onChange={categories => upSettings({ categories })} />
        </div>

        <div className={s.group}>
          <span className={s.labelText}>Rounds</span>
          <Seg<string> label="Rounds" value={String(S.rounds)}
            options={ROUND_OPTIONS.map(r => ({ value: String(r), label: String(r) }))}
            onChange={v => upSettings({ rounds: Number(v) })} />
        </div>

        {p.blocked.length > 0 && (
          <div className={s.group}>
            <span className={s.labelText}>Blocked artists</span>
            <div className={s.chips}>
              {p.blocked.map(a => (
                <button key={a} type="button" className={s.blockedChip} onClick={() => p.unblockArtist(a)} aria-label={`Bring back ${a}`}>
                  {a} <X size={14} strokeWidth={3} />
                </button>
              ))}
            </div>
            <p className={s.hint}>Tap one to let their songs back in.</p>
          </div>
        )}
      </div>

      {!p.invite && <GroupPanel invite="" clearInvite={p.clearInvite} showPastGames={p.showPastGames} />}

      <div className={sh.actions}>
        <div className={`${s.foot} ${sh.muted}`}>
          {room ? <>
            <span>{S.rounds} rounds of {ROOM_SONGS_PER_ROUND} songs.</span>
            <span>Phones join next</span>
          </> : <>
            <span>{S.rounds} rounds, one song each per round.</span>
            <span>{list.length} {mode === "teams" ? "teams" : "playing"}</span>
          </>}
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={room ? p.openRoom : p.startGame} disabled={!canStart}>
          {room ? "Open a room" : p.savedGame ? "Start a new show" : "Start the show"}
        </button>
      </div>
    </div>
  );
}

function ResumeCard({ game, onResume, onDiscard }: { game: GameState; onResume: () => void; onDiscard: () => void }){
  const who = game.cast[game.turn];
  return (
    <div className={s.resume}>
      <div className={s.resumeHead}>Show in progress</div>
      <p className={s.resumeLine}>
        Round {Math.min(game.round, game.totalRounds)} of {game.totalRounds}, {who?.name} is up next.
      </p>
      <div className={sh.row2}>
        <button type="button" className="btn btn-ghost" onClick={onDiscard}>Discard</button>
        <button type="button" className="btn btn-primary" onClick={onResume}>Resume</button>
      </div>
    </div>
  );
}

function RoomResumeCard({ show, onResume, onDiscard }: { show: HostShow; onResume: () => void; onDiscard: () => void }){
  return (
    <div className={s.resume}>
      <div className={s.resumeHead}>Buzz-in show in progress</div>
      <p className={s.resumeLine}>Room {show.code}, {show.songNo} of {show.total} songs played. Phones stay in their seats.</p>
      <div className={sh.row2}>
        <button type="button" className="btn btn-ghost" onClick={onDiscard}>Discard</button>
        <button type="button" className="btn btn-primary" onClick={onResume}>Resume</button>
      </div>
    </div>
  );
}

function NameChip({ name, canRemove, onRename, onRemove, small, strong }: {
  name: string; canRemove: boolean; onRename: (n: string) => void; onRemove: () => void; small?: boolean; strong?: boolean;
}){
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const cls = `${s.chip} ${small ? s.chipSmall : ""} ${strong ? s.chipStrong : ""}`;
  if (editing){
    const commit = () => { onRename(cleanName(draft, name)); setEditing(false); };
    return (
      <input autoFocus className={`${s.addInput} ${small ? s.chipSmall : ""}`} value={draft} maxLength={NAME_MAX} aria-label="Name"
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
    );
  }
  return (
    <span className={cls}>
      <button type="button" className={s.chipName} onClick={() => { setDraft(name); setEditing(true); }} aria-label={`Rename ${name}`}>{name}</button>
      {canRemove && (
        <button type="button" className={s.chipX} aria-label={`Remove ${name}`} onClick={onRemove}>
          <X size={small ? 12 : 14} strokeWidth={3} />
        </button>
      )}
    </span>
  );
}

function AddChip({ label, placeholder, onAdd, small }: { label: string; placeholder: string; onAdd: (n: string) => void; small?: boolean }){
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    const name = cleanName(draft, "");
    if (name) onAdd(name);
    setDraft(""); setAdding(false);
  };
  if (adding) return (
    <input autoFocus className={`${s.addInput} ${small ? s.chipSmall : ""}`} placeholder={placeholder} value={draft} maxLength={NAME_MAX} aria-label={placeholder}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape"){ setDraft(""); setAdding(false); } }} />
  );
  return (
    <button type="button" className={`${s.add} ${small ? s.chipSmall : ""}`} onClick={() => setAdding(true)}>
      <Plus size={small ? 12 : 14} strokeWidth={3} /> {label}
    </button>
  );
}
