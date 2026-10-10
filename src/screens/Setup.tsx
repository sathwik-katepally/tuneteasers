import { Fragment, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { ERAS } from "../lib/constants.js";
import { CATEGORIES, DIFFICULTY, MAX_CAST, MAX_MEMBERS, MIN_CAST, NAME_MAX, ROOM_SONGS_PER_ROUND, ROUND_OPTIONS } from "../lib/config";
import { cleanName, newId } from "../lib/save";
import { Seg } from "../components/Seg";
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
  hostShow: HostShow | null;
  openRoom: () => void;
  resumeRoom: () => void;
  discardRoom: () => void;
  joinRoom: () => void;
}

const ERA_ALL = "all";

/* The one line that stands in for the settings most shows never change. */
function summary(S: Settings){
  const kinds = S.categories.length ? S.categories.map(c => CATEGORIES.find(x => x.id === c)?.label).join(", ") : "any kind";
  return [S.eras.length === 1 ? S.eras[0] : "All eras", DIFFICULTY[S.difficulty].label, kinds, `${S.rounds} rounds`];
}

export function Setup(p: Props){
  const { settings: S, upSettings } = p;
  const mode = S.mode;
  const list = mode === "teams" ? p.teams : p.players;
  const setList = (l: RosterEntry[]) => p.setRoster(mode, l);
  const era = S.eras.length === 1 ? S.eras[0] : ERA_ALL;
  const room = S.play === "room";
  const canStart = room || list.length >= MIN_CAST[mode];
  const resumable = !!(p.savedGame || p.hostShow);
  const [fresh, setFresh] = useState(false);
  // A show that couldn't load came from these picks, so they open for changing.
  const [more, setMore] = useState(!!p.error);

  const add = (name: string) => setList([...list, { id: newId(), name, members: [] }]);
  const rename = (id: string, name: string) => setList(list.map(e => (e.id === id ? { ...e, name } : e)));
  const remove = (id: string) => setList(list.filter(e => e.id !== id));
  const patch = (id: string, changes: Partial<RosterEntry>) => setList(list.map(e => (e.id === id ? { ...e, ...changes } : e)));
  // The next free "Team N", so a team removed from the middle never leaves two with one name.
  const teamName = () => { let n = list.length + 1; while (list.some(e => e.name === `Team ${n}`)) n++; return `Team ${n}`; };
  const join = <button type="button" className={`link ${s.joinLink}`} onClick={p.joinRoom}>Got a code? Join a show</button>;

  return (
    <div className={sh.stage}>
      {p.error && <div className={s.error} role="alert">{p.error}</div>}
      {p.savedGame && <ResumeCard game={p.savedGame} onResume={p.resumeGame} onDiscard={p.discardGame} />}
      {p.hostShow && <RoomResumeCard show={p.hostShow} onResume={p.resumeRoom} onDiscard={p.discardRoom} />}

      {resumable && !fresh ? <>
        <button type="button" className={s.newShow} onClick={() => setFresh(true)}>
          Start a new show instead <ChevronDown size={16} strokeWidth={2.5} />
        </button>
        <div className={sh.actions}>{join}</div>
      </> : <>
        <div className={sh.paper}>
          <div className={s.head}>
            <h2 className={s.headTitle}>Tonight's show</h2>
          </div>

          <div className={s.group}>
            <span className={s.labelText}>How you play</span>
            <Seg<Play> label="How you play" tone="teal" value={S.play}
              options={[{ value: "pass", label: "Pass one phone" }, { value: "room", label: "Buzz in" }]}
              onChange={v => upSettings({ play: v })} />
            {room && <p className={s.hint}>This screen plays the songs. Friends join on their own phones with a code and buzz in.</p>}
          </div>

          {!room && (
            <div className={s.group}>
              <div className={s.label}>
                <span className={s.labelText}>Who's playing</span>
                <div className={s.modeSeg}>
                  <Seg<Mode> label="Play as" tone="teal" value={mode}
                    options={[{ value: "players", label: "Players" }, { value: "teams", label: "Teams" }]}
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
                  {list.map((e, i) => (
                    <TeamCard key={e.id} team={e} no={i + 1} canRemove={list.length > MIN_CAST.teams}
                      onChange={changes => patch(e.id, changes)} onRemove={() => remove(e.id)} />
                  ))}
                  {list.length < MAX_CAST && (
                    <button type="button" className={s.addTeam} onClick={() => add(teamName())}><Plus size={14} strokeWidth={3} /> Add a team</button>
                  )}
                  <p className={s.hint}>Name each team and, if you like, who's on it: the phone then goes round the team.</p>
                </div>
              )}
            </div>
          )}

          <div className={s.group}>
            <span className={s.labelText}>Songs in</span>
            <Seg<Mix> label="Language" value={S.mix}
              options={[{ value: "bolly", label: "Hindi" }, { value: "telugu", label: "Telugu" }, { value: "both", label: "Both" }]}
              onChange={v => upSettings({ mix: v })} />
          </div>

          <button type="button" className={s.summary} aria-expanded={more} aria-controls="tt-more" onClick={() => setMore(o => !o)}>
            <span className={s.summaryText}>{summary(S).map((x, i) => <Fragment key={i}>{i > 0 && " "}<span className="nowrap">{i ? "· " : ""}{x}</span></Fragment>)}</span>
            <span className={s.summaryAct}>{more ? "Done" : "Change"} <ChevronDown size={14} strokeWidth={3} className={more ? s.flip : ""} /></span>
          </button>

          {more && <div id="tt-more" className={s.more}>
            <div className={s.group}>
              <span className={s.labelText}>How hard</span>
              <Seg<Difficulty> label="Difficulty" value={S.difficulty}
                options={(Object.keys(DIFFICULTY) as Difficulty[]).map(d => ({ value: d, label: DIFFICULTY[d].label }))}
                onChange={v => upSettings({ difficulty: v })} />
              <p className={s.hint}>{DIFFICULTY[S.difficulty].note}</p>
            </div>

            <div className={s.group}>
              <span className={s.labelText}>Era</span>
              <Seg<string> label="Era" value={era}
                options={[...ERAS.map((e: string) => ({ value: e, label: e })), { value: ERA_ALL, label: "All" }]}
                onChange={v => upSettings({ eras: v === ERA_ALL ? [...ERAS] : [v] })} />
            </div>

            <div className={s.group}>
              <span className={s.labelText}>Kind of songs</span>
              <CategoryPicker settings={S} need={S.rounds * (room ? ROOM_SONGS_PER_ROUND : list.length)} blocked={p.blocked} onChange={categories => upSettings({ categories })} />
            </div>

            <div className={s.group}>
              <span className={s.labelText}>Rounds</span>
              <Seg<string> label="Rounds" value={String(S.rounds)}
                options={ROUND_OPTIONS.map(r => ({ value: String(r), label: String(r) }))}
                onChange={v => upSettings({ rounds: Number(v) })} />
              <p className={s.hint}>{room ? `${ROOM_SONGS_PER_ROUND} songs a round.` : "One song each per round."}</p>
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
          </div>}
        </div>

        <div className={`${sh.actions} ${s.sticky}`}>
          <button type="button" className="btn btn-primary btn-block" onClick={room ? p.openRoom : p.startGame} disabled={!canStart}>
            {room ? "Open a room" : resumable ? "Start a new show" : "Start the show"}
          </button>
          {join}
        </div>
      </>}
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
      <div className={s.resumeHead}><span className="nowrap">Buzz-in</span> show in progress</div>
      <p className={s.resumeLine}>Room {show.code}, {show.songNo} of {show.total} songs played. Phones stay in their seats.</p>
      <div className={sh.row2}>
        <button type="button" className="btn btn-ghost" onClick={onDiscard}>Discard</button>
        <button type="button" className="btn btn-primary" onClick={onResume}>Resume</button>
      </div>
    </div>
  );
}

/* A team's name is a plain text field, and who is on it one line of names,
   typed freely and split on commas once the field is left (so a comma on its
   way in is never lost). */
function TeamCard({ team, no, canRemove, onChange, onRemove }: {
  team: RosterEntry; no: number; canRemove: boolean; onChange: (changes: Partial<RosterEntry>) => void; onRemove: () => void;
}){
  const [who, setWho] = useState(team.members.join(", "));
  const commitWho = () => {
    const members = who.split(",").map(n => cleanName(n, "")).filter(Boolean).slice(0, MAX_MEMBERS);
    onChange({ members });
    setWho(members.join(", "));
  };
  return (
    <div className={s.teamCard}>
      <div className={s.teamHead}>
        <span className={s.teamNo}>Team {no}</span>
        <input className={s.teamName} value={team.name} maxLength={NAME_MAX} placeholder="Team name" aria-label={`Team ${no} name`}
          onChange={e => onChange({ name: e.target.value })} onBlur={() => onChange({ name: cleanName(team.name, `Team ${no}`) })} />
        {canRemove && (
          <button type="button" className={s.teamX} aria-label={`Remove ${team.name}`} onClick={onRemove}>
            <X size={16} strokeWidth={3} />
          </button>
        )}
      </div>
      <label className={s.teamWho}>
        <span>Who's on it</span>
        <input value={who} maxLength={(NAME_MAX + 2) * MAX_MEMBERS} placeholder="Names, optional" onChange={e => setWho(e.target.value)} onBlur={commitWho}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      </label>
    </div>
  );
}

function NameChip({ name, canRemove, onRename, onRemove }: { name: string; canRemove: boolean; onRename: (n: string) => void; onRemove: () => void }){
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (editing){
    const commit = () => { onRename(cleanName(draft, name)); setEditing(false); };
    return (
      <input autoFocus className={s.addInput} value={draft} maxLength={NAME_MAX} aria-label="Name"
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
    );
  }
  return (
    <span className={s.chip}>
      <button type="button" className={s.chipName} onClick={() => { setDraft(name); setEditing(true); }} aria-label={`Rename ${name}`}>{name}</button>
      {canRemove && (
        <button type="button" className={s.chipX} aria-label={`Remove ${name}`} onClick={onRemove}>
          <X size={14} strokeWidth={3} />
        </button>
      )}
    </span>
  );
}

function AddChip({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (n: string) => void }){
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    const name = cleanName(draft, "");
    if (name) onAdd(name);
    setDraft(""); setAdding(false);
  };
  if (adding) return (
    <input autoFocus className={s.addInput} placeholder={placeholder} value={draft} maxLength={NAME_MAX} aria-label={placeholder}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape"){ setDraft(""); setAdding(false); } }} />
  );
  return (
    <button type="button" className={s.add} onClick={() => setAdding(true)}>
      <Plus size={14} strokeWidth={3} /> {label}
    </button>
  );
}
