import { useEffect, useState } from "react";
import { setupCounts, type SetupCounts } from "../lib/crate";
import { CATEGORIES, DIFFICULTY } from "../lib/config";
import type { Category, Settings } from "../types";
import s from "./CategoryPicker.module.css";

/* The setup screen's song counts for these settings (setupCounts): undefined
   until the first ones load, null when the song list didn't load. While a
   change recounts, the last counts stay up, so the chips don't flicker, and
   recounting is true. */
export function useSetupCounts(S: Settings, need: number, blocked: string[]): { counts: SetupCounts | null | undefined; recounting: boolean } {
  const [loaded, setLoaded] = useState<{ key: string; counts: SetupCounts | null }>();
  const sound = DIFFICULTY[S.difficulty].sound;
  const key = JSON.stringify([S.langs, S.eras, sound, S.songs, S.categories, need, blocked]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setupCounts({ langs: S.langs, eras: S.eras, sound, songs: S.songs, minSongs: need, categories: S.categories }, CATEGORIES.map(c => c.id))
        .then(c => { if (live) setLoaded({ key, counts: c }); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return { counts: loaded?.counts, recounting: loaded?.key !== key };
}

interface Props {
  settings: Settings;
  need: number;
  counts: SetupCounts | null | undefined;
  recounting: boolean;
  onChange: (categories: Category[]) => void;
}

/* "Any" is the empty selection and clears the others; the rest combine (a
   song in any chosen category can come up). Only the categories the chosen
   languages have show. A category with fewer songs than the show needs is
   greyed out with its count; a chosen one stays tappable so it can be
   turned off. */
export function CategoryPicker({ settings: S, need, counts, recounting, onChange }: Props){
  const sound = DIFFICULTY[S.difficulty].sound;
  const chosen = new Set(S.categories);
  const shown = CATEGORIES.filter(c => !counts || counts.has.includes(c.id) || chosen.has(c.id));
  const toggle = (id: Category) => onChange(CATEGORIES.map(c => c.id).filter(c => (c === id ? !chosen.has(c) : chosen.has(c))));
  const thin = shown.filter(c => counts && counts.cats[c.id] < need);
  const offline = counts === null;

  return (
    <>
      <div className={s.grid} role="group" aria-label="Song categories" aria-busy={recounting}>
        <button type="button" className={`${s.stub} ${chosen.size ? "" : s.on}`} aria-pressed={!chosen.size} onClick={() => onChange([])}
          aria-label={counts ? `Any, ${counts.cats.any} songs` : "Any"}>
          <span className={s.name}>Any</span>
          <span className={s.count}>{counts ? counts.cats.any : ""}</span>
        </button>
        {shown.map(c => {
          const on = chosen.has(c.id);
          const n = counts ? counts.cats[c.id] : undefined;
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
            ? `Greyed out: not enough songs for ${need} turns. Music‑only needs a stretch with no singing, and few dance or item songs have one. With singing plays them all.`
            : `Greyed out: not enough songs for ${need} turns with these languages and eras.`}
        </p>
      )}
    </>
  );
}
