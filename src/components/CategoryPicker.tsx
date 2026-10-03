import { useEffect, useState } from "react";
import { categoryCounts } from "../lib/crate";
import { CATEGORIES, DIFFICULTY } from "../lib/config";
import type { Category, Settings } from "../types";
import s from "./CategoryPicker.module.css";

type Counts = Record<string, number>;

interface Props {
  settings: Settings;
  need: number;
  blocked: string[];
  onChange: (categories: Category[]) => void;
}

/* "Any" is the empty selection and clears the others; the rest combine (a
   song in any chosen category can come up). A category with fewer songs than
   the show needs is greyed out with its count; a chosen one stays tappable
   so it can be turned off. */
export function CategoryPicker({ settings: S, need, blocked, onChange }: Props){
  const [loaded, setLoaded] = useState<{ key: string; counts: Counts | null } | null>(null);
  const sound = DIFFICULTY[S.difficulty].sound;
  const erasKey = S.eras.join(",");
  const key = JSON.stringify([S.mix, erasKey, sound, S.difficulty, need, blocked]);
  const counts = loaded?.key === key ? loaded.counts : undefined;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      categoryCounts(S.mix, S.eras, sound, S.difficulty, need, CATEGORIES.map(c => c.id)).then(c => { if (live) setLoaded({ key, counts: c }); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = new Set(S.categories);
  const toggle = (id: Category) => onChange(CATEGORIES.map(c => c.id).filter(c => (c === id ? !chosen.has(c) : chosen.has(c))));
  const thin = CATEGORIES.filter(c => counts && counts[c.id] < need);
  const offline = counts === null;

  return (
    <>
      <div className={s.grid} role="group" aria-label="Song categories">
        <button type="button" className={`${s.stub} ${chosen.size ? "" : s.on}`} aria-pressed={!chosen.size} onClick={() => onChange([])}
          aria-label={counts ? `Any, ${counts.any} songs` : "Any"}>
          <span className={s.name}>Any</span>
          <span className={s.count}>{counts ? counts.any : ""}</span>
        </button>
        {CATEGORIES.map(c => {
          const on = chosen.has(c.id);
          const n = counts ? counts[c.id] : undefined;
          const short = offline || (n !== undefined && n < need);
          return (
            <button key={c.id} type="button" className={`${s.stub} ${on ? s.on : ""} ${short ? s.short : ""}`}
              aria-pressed={on} disabled={short && !on} onClick={() => toggle(c.id)}
              aria-label={n === undefined ? c.label : `${c.label}, ${n} songs`}>
              <span className={s.name}>{c.label}</span>
              <span className={s.count}>{n === undefined ? "" : short ? `only ${n}` : n}</span>
            </button>
          );
        })}
      </div>
      {offline ? (
        <p className={s.note}>Categories need the song list, which didn't load. Any still works.</p>
      ) : thin.length > 0 && (
        <p className={s.note}>
          {sound === "inst"
            ? `Greyed out: not enough songs for ${need} turns. Music\u2011only needs a stretch with no singing, and few dance or item songs have one. Easy plays them with vocals.`
            : `Greyed out: not enough songs for ${need} turns with these languages and eras.`}
        </p>
      )}
    </>
  );
}
