import { useState } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import { ChevronDown, Plus, Users, X } from "lucide-react";
import { Theatre } from "../components/Theatre";
import { Seg } from "../components/Seg";
import { CategoryPicker } from "../components/CategoryPicker";
import { BulbFrame } from "../components/Bulbs";
import { Qr } from "../components/Qr";
import { ERAS } from "../lib/constants.js";
import { CATEGORIES, DIFFICULTY, ROOM_SONGS_PER_ROUND, ROUND_OPTIONS, ladderFor } from "../lib/config";
import type { Category, Difficulty, Mix, Play, Settings } from "../types";
import sh from "../screens/shared.module.css";
import st from "../screens/Setup.module.css";
import ls from "../screens/Landing.module.css";
import lb from "../room/Lobby.module.css";
import s from "./Protos.module.css";

/* UX-audit prototypes (crew/tt-ux-audit), reached with ?proto=<name>.
   Mock screens only: nothing here starts a game or talks to the Worker. */

const PROTOS: { id: string; title: string; note: string }[] = [
  { id: "landing", title: "1. Landing: pick how you play", note: "The two modes become the two buttons, so the setup screen no longer asks." },
  { id: "setup", title: "2. Quick setup (pass the phone)", note: "Names and language up front, the rest folded into one line. Start never scrolls away." },
  { id: "setup-room", title: "3. Quick setup (buzz in)", note: "Same screen for a host: no roster, phones name themselves." },
  { id: "lobby", title: "4. Big-screen lobby", note: "On a laptop or TV the code and QR fill the screen, readable from the sofa." },
  { id: "after", title: "5. After the show", note: "Group and ticket are offered here, once the crowd has something worth keeping." },
  { id: "history", title: "6. One place for song history", note: "Group and ticket behind one question: who should never hear a repeat?" },
];

const go = (id: string) => { location.search = `?proto=${id}`; };

export function Protos({ which }: { which: string }){
  const body = which === "landing" ? <LandingProto />
    : which === "setup" ? <QuickSetup initial="pass" />
    : which === "setup-room" ? <QuickSetup initial="room" />
    : which === "lobby" ? <BigLobby />
    : which === "after" ? <AfterShow />
    : which === "history" ? <History />
    : <Index />;
  if (which === "landing") return body;
  const wide = which === "lobby";
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <div className={wide ? s.wide : undefined}>
          <Theatre meta={wide ? "Room KFHB" : "Now showing"} game={null} onHome={() => {}} onEnd={() => {}} onAbout={() => go("landing")}>
            <div className="screen">{body}</div>
          </Theatre>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}

function Index(){
  return (
    <div className={sh.stage}>
      <div className={sh.paper}>
        <div className={st.head}>
          <h2 className={st.headTitle}>Prototypes</h2>
          <span className={st.headMeta}>UX audit</span>
        </div>
        {PROTOS.map(p => (
          <a key={p.id} className={s.indexRow} href={`?proto=${p.id}`}>
            <b>{p.title}</b>
            <span>{p.note}</span>
          </a>
        ))}
      </div>
      <p className={s.protoNote}>Mock screens. Nothing here starts a game; buttons move between prototypes.</p>
    </div>
  );
}

const EASY = ladderFor(true);
const LADDER = EASY.segments.map((secs, i) => ({ label: i === 0 ? `${secs}s` : `+${secs}s`, points: EASY.points[i] }));

function LandingProto(){
  return (
    <main className={ls.root}>
      <div className={ls.rays} aria-hidden />
      <div className={ls.grid}>
        <div className={ls.hero}>
          <p className={ls.brand}>Tune Teasers</p>
          <h1 className={ls.head}>
            <span className={ls.line}>Which film</span>
            <span className={ls.line}>is this <em>song</em></span>
            <span className={ls.line}>from?</span>
          </h1>
          <p className={ls.lede}>A party game for Hindi and Telugu film songs. Hear a few seconds, then name the song or the film.</p>
        </div>
        <div className={ls.side}>
          <div>
            <p className={ls.label}>The less you hear, the more it's worth</p>
            <ol className={ls.ladder}>
              {LADDER.map(r => (
                <li key={r.label} className={ls.rung}><span className={ls.secs}>{r.label}</span><span className={ls.pts}>{r.points} pts</span></li>
              ))}
            </ol>
          </div>
          <div className={s.modeButtons}>
            <button type="button" className={s.modeBtn} onClick={() => go("setup")}>
              <span className={s.modeTitle}>Pass one phone</span>
              <span className={s.modeSub}>Everyone takes turns on this phone.</span>
            </button>
            <button type="button" className={`${s.modeBtn} ${s.modeAlt}`} onClick={() => go("setup-room")}>
              <span className={s.modeTitle}>Buzz in from every phone</span>
              <span className={s.modeSub}>This screen plays, friends join with a code.</span>
            </button>
            <button type="button" className="link" onClick={() => go("setup")}>Got a room code? Join a show</button>
          </div>
        </div>
      </div>
    </main>
  );
}

const ERA_ALL = "all";
const soundOf = (d: Difficulty) => (DIFFICULTY[d].sound === "full" ? "with singing" : "music only");

function QuickSetup({ initial }: { initial: Play }){
  const [play, setPlay] = useState<Play>(initial);
  const [names, setNames] = useState(["Player 1", "Player 2"]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [S, setS] = useState<Settings>({ play: initial, mix: "both", eras: [...ERAS], difficulty: "medium", categories: [], mode: "players", rounds: 5 });
  const up = (patch: Partial<Settings>) => setS(x => ({ ...x, ...patch }));
  const room = play === "room";
  const era = S.eras.length === 1 ? S.eras[0] : ERA_ALL;
  const kinds = S.categories.length ? S.categories.map(c => CATEGORIES.find(x => x.id === c)?.label).join(", ") : "any kind";
  const summary = [era === ERA_ALL ? "All eras" : era, `${DIFFICULTY[S.difficulty].label}, ${soundOf(S.difficulty)}`, kinds, `${S.rounds} rounds`];
  const commit = () => { const n = draft.trim(); if (n) setNames(l => [...l, n]); setDraft(""); setAdding(false); };

  return (
    <div className={sh.stage}>
      <div className={sh.paper}>
        <div className={st.head}>
          <h2 className={st.headTitle}>Tonight's show</h2>
        </div>

        <div className={st.group}>
          <Seg<Play> label="How you play" tone="teal" value={play}
            options={[{ value: "pass", label: "Pass one phone" }, { value: "room", label: "Buzz in" }]}
            onChange={v => { setPlay(v); up({ play: v }); }} />
        </div>

        {!room ? (
          <div className={st.group}>
            <div className={st.label}>
              <span className={st.labelText}>Who's playing</span>
              <button type="button" className={`link ${s.small}`}><Users size={14} /> Teams instead</button>
            </div>
            <div className={st.chips}>
              {names.map((n, i) => (
                <span key={i} className={st.chip}>
                  <span className={st.chipName}>{n}</span>
                  {names.length > 1 && <button type="button" className={st.chipX} aria-label={`Remove ${n}`} onClick={() => setNames(l => l.filter((_, j) => j !== i))}><X size={14} strokeWidth={3} /></button>}
                </span>
              ))}
              {adding
                ? <input autoFocus className={st.addInput} placeholder="Name" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === "Enter") commit(); }} />
                : <button type="button" className={st.add} onClick={() => setAdding(true)}><Plus size={14} strokeWidth={3} /> Add</button>}
            </div>
          </div>
        ) : (
          <div className={st.group}>
            <p className={st.hint}>This screen plays the songs. Friends open the site on their phones, type the room code and buzz in.</p>
          </div>
        )}

        <div className={st.group}>
          <span className={st.labelText}>Songs in</span>
          <Seg<Mix> label="Language" value={S.mix}
            options={[{ value: "bolly", label: "Hindi" }, { value: "telugu", label: "Telugu" }, { value: "both", label: "Both" }]}
            onChange={v => up({ mix: v })} />
        </div>

        <button type="button" className={s.summary} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span className={s.summaryText}>{summary.join(" · ")}</span>
          <span className={s.summaryAct}>{open ? "Done" : "Change"} <ChevronDown size={14} className={open ? s.flip : ""} /></span>
        </button>

        {open && <>
          <div className={st.group}>
            <span className={st.labelText}>How hard</span>
            <Seg<Difficulty> label="Difficulty" value={S.difficulty}
              options={(Object.keys(DIFFICULTY) as Difficulty[]).map(d => ({ value: d, label: DIFFICULTY[d].label }))}
              onChange={v => up({ difficulty: v })} />
            <p className={st.hint}>{DIFFICULTY[S.difficulty].note}</p>
          </div>
          <div className={st.group}>
            <span className={st.labelText}>Era</span>
            <Seg<string> label="Era" value={era}
              options={[...ERAS.map((e: string) => ({ value: e, label: e })), { value: ERA_ALL, label: "All" }]}
              onChange={v => up({ eras: v === ERA_ALL ? [...ERAS] : [v] })} />
          </div>
          <div className={st.group}>
            <span className={st.labelText}>Kind of songs</span>
            <CategoryPicker settings={S} need={S.rounds * (room ? ROOM_SONGS_PER_ROUND : names.length)} blocked={[]} onChange={(categories: Category[]) => up({ categories })} />
          </div>
          <div className={st.group}>
            <span className={st.labelText}>Rounds</span>
            <Seg<string> label="Rounds" value={String(S.rounds)}
              options={ROUND_OPTIONS.map(r => ({ value: String(r), label: String(r) }))}
              onChange={v => up({ rounds: Number(v) })} />
          </div>
        </>}
      </div>

      <div className={`${sh.actions} ${s.sticky}`}>
        <button type="button" className="btn btn-primary btn-block" onClick={() => go(room ? "lobby" : "after")}>
          {room ? "Open a room" : "Start the show"}
        </button>
        <button type="button" className={`link ${s.under}`} onClick={() => go("landing")}>
          {room ? "Joining someone else's room? Use a code" : "Someone else hosting? Join with a code"}
        </button>
      </div>
    </div>
  );
}

function BigLobby(){
  const code = "KFHB";
  const players = ["Asha", "Ravi", "Meena"];
  return (
    <div className={`${sh.stage} ${s.lobby}`}>
      <div className={s.lobbyLeft}>
        <div className={lb.board}>
          <BulbFrame mode="chase" gap={22} inset={7} size={8} />
          <span className={lb.eyebrow}>Room code</span>
          <div className={lb.letters}>
            {code.split("").map((c, i) => <span key={i} className={`${lb.letter} ${s.bigLetter}`}>{c}</span>)}
          </div>
          <span className={lb.status}>Doors open</span>
        </div>
        <div className={s.bigJoin}>
          <Qr text={`${location.origin}${location.pathname}#room=${code}`} className={s.bigQr} label="QR code to join this room" />
          <p className={s.bigHow}>Point your phone camera here.<br />Or open <b>sathwik-katepally.github.io/tuneteasers</b> and type <b>{code}</b>.</p>
        </div>
      </div>
      <div className={s.lobbyRight}>
        <div className={`${sh.paper} ${lb.house}`}>
          <div className={lb.houseHead}>
            <h2 className={lb.houseTitle}>In the house</h2>
            <span className={lb.count}>{players.length} in</span>
          </div>
          <div className={lb.chips}>
            {players.map(p => <span key={p} className={`${lb.chip} ${s.lobbyChip}`}>{p}</span>)}
          </div>
        </div>
        <div className={sh.actions}>
          <div className={`${lb.foot} ${sh.muted}`}><span>Hindi and Telugu, Medium</span><span>5 rounds of {ROOM_SONGS_PER_ROUND} songs</span></div>
          <button type="button" className="btn btn-primary btn-block" onClick={() => go("after")}>Start the show</button>
          <p className={s.protoNote}>During the songs a small "Join: {code}" tag and QR stay in the corner, so late arrivals get in.</p>
        </div>
      </div>
    </div>
  );
}

function AfterShow(){
  const [done, setDone] = useState(false);
  return (
    <div className={sh.stage}>
      <div className={s.afterHead}>
        <BulbFrame mode="twinkle" gap={20} inset={6} size={8} />
        <p className={s.afterEyebrow}>Premiere night</p>
        <h2 className={s.afterWinner}>Asha takes it</h2>
        <p className={s.afterRest}>1. <b>Asha</b> 540 · 2. <b>Ravi</b> 410 · 3. <b>Meena</b> 260</p>
      </div>

      {!done ? (
        <section className={s.offer} aria-label="Keep tonight's songs">
          <span className={s.offerEyebrow}>Playing again another night?</span>
          <p className={s.offerText}>Tonight's 15 songs can stay off the list next time, even on someone else's phone.</p>
          <div className={sh.row2}>
            <button type="button" className="btn btn-ghost" onClick={() => setDone(true)}>Not now</button>
            <button type="button" className="btn btn-teal" onClick={() => go("history")}>Keep them off</button>
          </div>
        </section>
      ) : <p className={s.protoNote}>Asked once. It stays in the menu under "Song history".</p>}

      <div className={sh.actions}>
        <div className={sh.row2}>
          <button type="button" className="btn btn-ghost" onClick={() => go("setup")}>New show</button>
          <button type="button" className="btn btn-primary" onClick={() => go("setup")}>Same crowd again</button>
        </div>
      </div>
    </div>
  );
}

function History(){
  const [pick, setPick] = useState<"" | "crowd" | "me">("");
  return (
    <div className={sh.stage}>
      <div className={sh.paper}>
        <div className={st.head}>
          <h2 className={st.headTitle}>No repeats</h2>
          <span className={st.headMeta}>Song history</span>
        </div>
        <div className={st.group}>
          <p className={s.historyLede}>Who should never get the same song twice?</p>
          <button type="button" className={`${s.choice} ${pick === "crowd" ? s.choiceOn : ""}`} onClick={() => setPick("crowd")}>
            <b>This crowd, on all our phones</b>
            <span>Link the phones you play on. Any of them skips songs the others played, and past shows are kept.</span>
          </button>
          <button type="button" className={`${s.choice} ${pick === "me" ? s.choiceOn : ""}`} onClick={() => setPick("me")}>
            <b>Just me, wherever I play</b>
            <span>Your name and history go with you to any phone or buzz-in room. Face ID or fingerprint gets it back on a new phone.</span>
          </button>
        </div>
      </div>
      <div className={sh.actions}>
        <button type="button" className="btn btn-teal btn-block" disabled={!pick}>
          {pick === "me" ? "Make my ticket" : pick === "crowd" ? "Link our phones" : "Choose one"}
        </button>
        <p className={s.protoNote}>Today these are two separate cards on the home screen (group and ticket), both shown before the first song.</p>
      </div>
    </div>
  );
}
