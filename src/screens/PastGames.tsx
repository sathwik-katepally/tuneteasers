import { useEffect, useState } from "react";
import { DIFFICULTY } from "../lib/config";
import { GroupError, fetchResults, type Group, type GroupResult } from "../lib/group";
import sh from "./shared.module.css";
import s from "./PastGames.module.css";

const MIX = { bolly: "Hindi", telugu: "Telugu", both: "Hindi + Telugu" } as const;

function when(ms: number){
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit",
  }).format(d);
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; results: GroupResult[]; more: boolean; older?: boolean };

export function PastGames({ group, onBack }: { group: Group; onBack: () => void }){
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    fetchResults().then(
      r => live && setLoad({ state: "ok", ...r }),
      e => live && setLoad({ state: "error", message: e instanceof GroupError && (e.status === 401 || e.status === 403)
        ? "This group was deleted, or its invite no longer works."
        : "Couldn't reach the group. Check the connection and try again." }),
    );
    return () => { live = false; };
  }, [group.id, tick]);

  async function older(){
    if (load.state !== "ok" || !load.results.length) return;
    setLoad({ ...load, older: true });
    try {
      const r = await fetchResults(load.results[load.results.length - 1].finishedAt);
      setLoad({ state: "ok", results: [...load.results, ...r.results], more: r.more });
    } catch {
      setLoad({ ...load, older: false });
    }
  }

  return (
    <div className={sh.stage}>
      <div className={sh.paper}>
        <div className={s.head}>
          <h2 className={s.title}>Past shows</h2>
          <span className={s.meta}>{group.name}</span>
        </div>
        {load.state === "loading" && <p className={s.empty}>Opening the ledger…</p>}
        {load.state === "error" && (
          <div className={s.empty} role="alert">
            <p>{load.message}</p>
            <button type="button" className={`link ${s.retry}`} onClick={() => setTick(t => t + 1)}>Try again</button>
          </div>
        )}
        {load.state === "ok" && !load.results.length && (
          <p className={s.empty}>No finished shows yet. When a show ends on any phone in the group, it lands here.</p>
        )}
        {load.state === "ok" && load.results.length > 0 && (
          <ol className={s.list}>
            {load.results.map(r => <ResultRow key={r.id} r={r} />)}
          </ol>
        )}
        {load.state === "ok" && load.more && (
          <button type="button" className={`link ${s.older}`} onClick={older} disabled={load.older}>{load.older ? "Loading" : "Show older shows"}</button>
        )}
      </div>
      <div className={sh.actions}>
        <p className={`${s.foot} ${sh.muted}`}>Shows are kept for a year.</p>
        <button type="button" className="btn btn-cream btn-block" onClick={onBack}>Back to the booking counter</button>
      </div>
    </div>
  );
}

function ResultRow({ r }: { r: GroupResult }){
  const ranked = [...r.cast].sort((a, b) => b.score - a.score);
  const place = (score: number) => ranked.findIndex(c => c.score === score) + 1;
  return (
    <li className={s.result}>
      <div className={s.resultHead}>
        <span className={s.date}>{when(r.finishedAt)}</span>
        <span className={s.settings}>
          {r.mode === "teams" ? "Teams" : "Solo"} · {DIFFICULTY[r.difficulty]?.label ?? r.difficulty} · {MIX[r.mix] ?? r.mix} · {r.rounds} rounds
        </span>
      </div>
      <ol className={s.standings}>
        {ranked.map((c, i) => (
          <li key={i} className={place(c.score) === 1 ? s.winner : ""}>
            <span className={s.place}>{place(c.score)}</span>
            <span className={s.who}>
              {c.name}
              {c.members.length > 0 && <small className={s.members}>{c.members.join(", ")}</small>}
            </span>
            <b className={s.score}>{c.score}</b>
          </li>
        ))}
      </ol>
    </li>
  );
}
