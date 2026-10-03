import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BulbFrame } from "../components/Bulbs";
import { Reel } from "../components/Reel";
import { Stamp } from "../components/Stamp";
import { Stage } from "../components/Stage";
import { Ticket } from "../components/Ticket";
import { NAME_MAX } from "../lib/config";
import { prepareTitles, suggest } from "../lib/answer.js";
import { answerTitles } from "../lib/crate";
import { displayTitle } from "../lib/utils.js";
import { cleanCode, dropSeat, heardPayload, isCode, lastName, loadSeat, newSeat, playerName, rememberName, setRoomUrl, useMsLeft,
  useRecordHeard, useRoom, type RoomView, type Seat } from "../lib/room";
import sh from "../screens/shared.module.css";
import s from "./Phone.module.css";

const JOIN_ERRORS: Record<string, string> = {
  "name-taken": "Someone in the room already has that name. Add an initial.",
  name: "Type your name first.",
  full: "This room is full.",
};
const GONE: Record<number, string> = {
  4404: "There's no room with that code. Check the big screen.",
  4410: "That room has closed. Ask the host for the new code.",
  4403: "The host took you out of the room.",
};

/* A phone in a buzz-in room: join with the code, then it is a buzzer and an
   answer pad. It never plays audio and never learns the song before the
   reveal; the room decides who answers and whether they are right. */
export function Phone({ code: initial, onExit }: { code: string; onExit: () => void }){
  const [code, setCode] = useState(initial);
  const [seat, setSeat] = useState<Seat | null>(() => (initial ? loadSeat(initial) : null));
  const [name, setName] = useState(lastName);
  const [joining, setJoining] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  // A code that came in a link is shown as fixed text; typing one is only for when it didn't work.
  const [linked, setLinked] = useState(() => isCode(initial));
  // Read at every (re)connect, so the seat always has this phone's latest history.
  const hello = seat ? () => ({ t: "join", key: seat.key, name: joining ?? "", heard: heardPayload() }) : null;
  const room = useRoom(seat ? code : "", hello);
  const view = room.view;
  const me = view?.me ?? null;
  useRecordHeard(me ? view : null);

  useEffect(() => { setRoomUrl(seat ? code : ""); }, [seat, code]);

  useEffect(() => {
    if (!room.error) return;
    const msg = JOIN_ERRORS[room.error.code];
    // A saved seat the room no longer has (removed, or a new show) just asks for the name again.
    if (msg && !me){ setNotice(joining === null && room.error.code === "name" ? "" : msg); setSeat(null); dropSeat(); }
  }, [room.error?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!room.gone) return;
    setNotice(GONE[room.gone.code] ?? "Lost the room.");
    if (room.gone.code !== 4403) setLinked(false);
    setSeat(null);
    dropSeat();
  }, [room.gone]);

  function join(e: FormEvent){
    e.preventDefault();
    const c = cleanCode(code);
    const n = name.trim().slice(0, NAME_MAX);
    if (!isCode(c)){ setNotice("Room codes are four letters, on the big screen."); return; }
    if (!n){ setNotice(JOIN_ERRORS.name); return; }
    rememberName(n);
    setNotice("");
    setCode(c);
    setJoining(n);
    setSeat(loadSeat(c) ?? newSeat(c));
  }

  function leave(){
    room.send({ t: "leave" });
    room.leave();
    dropSeat();
    setRoomUrl("");
    onExit();
  }

  let key = "join", screen: React.ReactNode;
  if (!seat){
    screen = <JoinForm code={code} linked={linked} onUnlink={() => setLinked(false)} name={name} notice={notice} onCode={v => setCode(cleanCode(v))} onName={setName} onJoin={join} onBack={() => { setRoomUrl(""); onExit(); }} />;
  } else if (!view || !me){
    key = "connecting";
    screen = (
      <div className={sh.stage}>
        <div className={s.center}>
          <Reel size={90} className={s.reel} />
          <p className={s.status}>{room.link === "retrying" ? "Reconnecting" : `Finding room ${code}`}</p>
        </div>
      </div>
    );
  } else if (view.phase === "lobby"){
    key = "lobby";
    screen = <Waiting view={view} onLeave={leave} />;
  } else if (view.phase === "over"){
    key = "over";
    screen = <Final view={view} onLeave={leave} />;
  } else {
    key = "show";
    screen = <Buzzer view={view} send={room.send} online={room.link === "open"} error={room.error} />;
  }

  return (
    <Stage screenKey={key} meta={seat ? `Room ${code}` : "Join a show"} game={null} onHome={() => {}} onEnd={() => {}}>
      {screen}
    </Stage>
  );
}

function JoinForm({ code, linked, onUnlink, name, notice, onCode, onName, onJoin, onBack }: {
  code: string; linked: boolean; onUnlink: () => void; name: string; notice: string;
  onCode: (v: string) => void; onName: (v: string) => void; onJoin: (e: FormEvent) => void; onBack: () => void;
}){
  return (
    <form className={sh.stage} onSubmit={onJoin}>
      <div className={`${sh.paper} ${s.joinCard}`}>
        <div className={s.joinHead}>
          <h2 className={s.joinTitle}>Take your seat</h2>
          <span className={`${s.joinMeta} nowrap`}>Buzz-in show</span>
        </div>
        {linked ? (
          <div className={s.field}>
            <span className={s.label}>Room code</span>
            <div className={s.fixedCode}>
              <span className={s.fixedLetters} aria-label={`Room code ${code}`}>{code}</span>
              <button type="button" className={`link ${s.change}`} onClick={onUnlink}>Change</button>
            </div>
          </div>
        ) : <label className={s.field}>
          <span className={s.label}>Room code</span>
          <input className={`${s.input} ${s.codeInput}`} value={code} onChange={e => onCode(e.target.value)} placeholder="ABCD"
            autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} inputMode="text" maxLength={4} aria-label="Room code" />
        </label>}
        <label className={s.field}>
          <span className={s.label}>Your name</span>
          <input className={s.input} value={name} onChange={e => onName(e.target.value)} placeholder="Name" maxLength={NAME_MAX} autoFocus={linked}
            autoComplete="nickname" enterKeyHint="go" aria-label="Your name" />
        </label>
        <p className={s.hint}>The big screen plays the songs. Your phone is your buzzer.</p>
      </div>
      {notice && <p className={s.notice} role="alert">{notice}</p>}
      <div className={sh.actions}>
        <button type="submit" className="btn btn-primary btn-block">Join the show</button>
        <button type="button" className={`link ${s.leave}`} onClick={onBack}>Back to the start</button>
      </div>
    </form>
  );
}

function Waiting({ view, onLeave }: { view: RoomView; onLeave: () => void }){
  const mine = view.players.find(p => p.id === view.me);
  const others = view.players.filter(p => p.id !== view.me);
  return (
    <div className={sh.stage}>
      <div className={s.center}>
        <p className={s.eyebrow}>You're in</p>
        <Ticket stub={`Room ${view.code}`}>
          <h2 className={s.ticketName}>{mine?.name}</h2>
          <p className={s.ticketMeta}>Seat {view.players.findIndex(p => p.id === view.me) + 1} of {view.players.length}</p>
        </Ticket>
        <p className={s.note}>Eyes on the big screen. The show starts when the host is ready.</p>
        {others.length > 0 && <p className={s.others}>With {others.map(p => p.name).join(", ")}</p>}
      </div>
      <div className={sh.actions}>
        <button type="button" className={`link ${s.leave}`} onClick={onLeave}>Leave the room</button>
      </div>
    </div>
  );
}

function Buzzer({ view, send, online, error }: {
  view: RoomView; send: (m: object) => boolean; online: boolean; error: { code: string; at: number } | null;
}){
  const song = view.song;
  const me = view.me!;
  const mine = view.players.find(p => p.id === me);
  const msLeft = useMsLeft(view);
  const [text, setText] = useState("");
  const [pressed, setPressed] = useState<number | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const state = song?.state ?? "cue";
  const answering = state === "answering" && song?.answering === me;
  const queued = !!song?.queue.includes(me);
  const out = !!song?.locked.includes(me);
  const place = song ? song.queue.indexOf(me) : -1;
  const open = (state === "live" || state === "answering" || state === "missed") && !out && !queued && online;
  const titles = useAnswerTitles(view.mix);
  // "Heard it" votes are open once the clip plays, until anyone buzzes.
  const votable = state === "live" && !!song && !song.queue.length && !song.guesses.length && online;
  const voted = !!song?.votes.includes(me);
  const skipsLeft = view.skips.max - view.skips.used;
  const hints = useMemo(() => suggest(text, titles, 5), [text, titles]);

  // A new song, or my turn ending, clears the pad.
  useEffect(() => { setText(""); setSent(null); setPressed(null); }, [song?.n]);
  useEffect(() => { if (!answering){ setSent(null); if (document.activeElement === input.current) input.current?.blur(); } }, [answering]);
  useEffect(() => { if (answering) input.current?.focus(); }, [answering]);
  useEffect(() => { if (error?.code === "not-your-turn") setSent(null); }, [error?.at]);

  function buzz(){
    if (!open) return;
    if (send({ t: "buzz" })){
      setPressed(Date.now());
      navigator.vibrate?.(35);
    }
  }
  // iOS only raises the keyboard for a focus made inside a tap, so the pad's
  // input takes focus on the buzz itself when this buzz is likely to be first.
  function buzzTap(){
    if (state !== "answering" && open) input.current?.focus({ preventScroll: true });
  }
  function answer(t: string){
    const v = t.trim();
    if (!answering || !v || sent) return;
    if (send({ t: "answer", text: v })){ setSent(v); setText(v); }
  }

  const secs = msLeft === null ? null : Math.ceil(msLeft / 1000);
  const lastGuess = song?.guesses.filter(g => g.id === me).at(-1);
  const answer_ = song?.answer;
  const won = song?.winner === me;

  let label: string, sub: string;
  if (!online){ label = "Wait"; sub = "Reconnecting to the room"; }
  else if (state === "revealed"){ label = "Buzz"; sub = ""; }
  else if (out){ label = "Out"; sub = lastGuess?.timeout ? "Time ran out. You're out for this song." : "Not it. You're out for this song."; }
  else if (queued && !answering){ label = `#${place + 1}`; sub = `In line. ${playerName(view, song!.answering)} is answering.`; }
  else if (state === "answering"){ label = "Buzz"; sub = `${playerName(view, song!.answering)} is answering. Buzz to go next.`; }
  else if (state === "live"){ label = "Buzz"; sub = "Buzz the moment you know it"; }
  else if (state === "skipped"){ label = "Wait"; sub = "Skipped. Another song is on its way."; }
  else if (state === "missed"){ label = "Buzz"; sub = "Nobody yet. Buzz if that jogged your memory, or hear more."; }
  else { label = "Wait"; sub = song ? "Ears on. The clip starts in a moment." : "Get ready for the first song"; }

  return (
    <div className={sh.stage}>
      <div className={s.top}>
        <span className={s.meName}>{mine?.name}</span>
        <span className={s.score}>{song ? `Song ${song.n} of ${view.total}` : "First song"} · <b>{mine?.score ?? 0}</b></span>
      </div>

      <form className={`${s.pad} ${answering ? "" : s.stowed}`} onSubmit={e => { e.preventDefault(); answer(text); }} aria-hidden={!answering}>
        <div className={s.padHead}>
          <span className={s.label}>Name the song</span>
          {secs !== null && answering && <span className={`${s.secs} ${secs <= 5 ? s.secsLow : ""}`}>{secs}s</span>}
        </div>
        {answering && <p className={s.worth}>Worth {song?.points ?? 0} if you're right. One try.</p>}
        <input ref={input} className={s.input} value={text} onChange={e => setText(e.target.value)} disabled={!!sent}
          placeholder="Start typing the song" autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck={false}
          enterKeyHint="go" aria-label="Your answer" tabIndex={answering ? 0 : -1} maxLength={80} />
        {answering && !sent && hints.length > 0 && (
          <div className={s.hints} role="listbox" aria-label="Songs">
            {hints.map(h => (
              <button key={h} type="button" role="option" aria-selected={false} className={s.hint_} onClick={() => answer(h)}>{h}</button>
            ))}
          </div>
        )}
        {answering && (
          <button type="submit" className="btn btn-primary btn-block" disabled={!text.trim() || !!sent}>{sent ? "Checking" : "Lock it in"}</button>
        )}
      </form>

      {!answering && state === "revealed" && song ? (
        <div className={s.resultWrap}>
          <div className={s.result}>
            <span className={s.resultWho}>{won ? "You got it" : song.winner ? `${playerName(view, song.winner)} got it` : "Nobody got it"}</span>
            <h2 className={s.resultTitle}>{answer_ ? displayTitle(answer_.title) : ""}</h2>
            {answer_ && (answer_.film || answer_.year > 0) && <p className={s.resultFilm}>{[answer_.film, answer_.year || ""].filter(Boolean).join(", ")}</p>}
            {won && <div className={s.resultStamp}><Stamp text={`+${song.won}`} sub="Housefull" rotate={-7} /></div>}
          </div>
          <p className={s.sub}>{lastGuess && !lastGuess.ok ? (lastGuess.timeout ? "You ran out of time on this one." : `You said “${lastGuess.text}”.`) : "Next song in a moment."}</p>
        </div>
      ) : !answering && (
        <div className={s.buzzWrap}>
          <button type="button" className={`${s.buzz} ${open ? s.buzzLive : ""} ${pressed && queued ? s.buzzIn : ""}`}
            onPointerDown={buzz} onClick={e => { if (e.detail === 0) buzz(); buzzTap(); }} aria-disabled={!open} aria-label={open ? "Buzz" : sub}>
            {open && <BulbFrame mode="fast" gap={20} inset={8} size={8} />}
            <span className={s.buzzText}>{label}</span>
          </button>
          <p className={s.sub} aria-live="polite">{sub}</p>
          {votable && skipsLeft > 0 && (
            <button type="button" className={`link ${s.vote}`} onClick={() => send({ t: "vote", cue: song!.cue })} disabled={voted}>
              {voted ? `Voted to skip · ${song!.votes.length} of ${song!.votesNeeded}`
                : song!.votes.length ? `Heard it too much · ${song!.votes.length} of ${song!.votesNeeded}` : "Heard it too much"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* The phone loads the public title list itself: the room never sends one,
   so nothing a phone receives hints at the show's songs. */
function useAnswerTitles(mix: RoomView["mix"]){
  const [list, setList] = useState<{ title: string; forms: string[] }[]>([]);
  useEffect(() => {
    let live = true;
    answerTitles(mix).then(t => { if (live) setList(prepareTitles(t)); }, () => {});
    return () => { live = false; };
  }, [mix]);
  return list;
}

function Final({ view, onLeave }: { view: RoomView; onLeave: () => void }){
  const ranked = [...view.players].sort((a, b) => b.score - a.score);
  const mine = ranked.find(p => p.id === view.me);
  const place = mine ? ranked.findIndex(p => p.score === mine.score) + 1 : 0;
  const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
  return (
    <div className={sh.stage}>
      <div className={s.final}>
        <p className={s.eyebrow}>That's the show</p>
        <h2 className={s.finalPlace}>{place === 1 ? "You take it" : `${ord(place)} place`}</h2>
        <p className={s.finalScore}>{mine?.score ?? 0} points</p>
        <ol className={s.ranks}>
          {ranked.map(p => (
            <li key={p.id} className={p.id === view.me ? s.rankMe : ""}><span>{p.name}</span><b>{p.score}</b></li>
          ))}
        </ol>
        <p className={s.note}>Stay here if the host runs it again.</p>
      </div>
      <div className={sh.actions}>
        <button type="button" className={`link ${s.leave}`} onClick={onLeave}>Leave the room</button>
      </div>
    </div>
  );
}
