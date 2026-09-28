/* Typed answers in buzz-in rooms. Shared by the phone (autocomplete) and the
   room Durable Object (the only place a guess is judged), so both sides fold
   titles the same way. Plain JS with no DOM: the Worker bundles it too. */
import { songKey, displayTitle } from "./utils.js";

/* Romanised Hindi and Telugu have no fixed spelling ("Pyaar"/"Pyar",
   "Mein"/"Main", "Dhoom"/"Dhum", "Zara"/"Jara"), so both the guess and the
   title are folded to a rough sound-alike key before comparing. Over-folding
   only makes two different titles look closer; the exact-other-title rule in
   isCorrect keeps that from scoring a wrong pick. */
const FOLDS = [
  [/ph/g, "f"], [/chh|ch/g, "c"], [/([kgjtdbs])h/g, "$1"],
  [/w/g, "v"], [/z/g, "j"], [/q/g, "k"],
  [/ee|ii|ie/g, "i"], [/oo|uu/g, "u"], [/aa/g, "a"], [/ai|ei|ay/g, "e"],
  [/([a-z])\1+/g, "$1"],
];

export function fold(s){
  let t = songKey(displayTitle(String(s || "")).normalize("NFKD").replace(/\p{M}/gu, ""));
  for (const [rx, to] of FOLDS) t = t.replace(rx, to);
  return t;
}

const squash = s => fold(s).replace(/ /g, "");

function distance(a, b){
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++){
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

const slack = len => (len <= 4 ? 0 : len <= 8 ? 1 : len <= 14 ? 2 : 3);

/* Right when the folded guess is the title, or a typo away from it, unless the
   guess is exactly another title on the show's list (a deliberate wrong pick
   that happens to look alike). */
export function isCorrect(guess, title, others = []){
  const g = squash(guess), t = squash(title);
  if (!g || !t) return false;
  if (g === t) return true;
  if (others.some(o => { const k = squash(o); return k && k !== t && k === g; })) return false;
  return distance(g, t) <= slack(t.length);
}

/* Titles whose folded form sits within the same typo allowance of `title`.
   The host sends these to the room with each song, so a guess that is exactly
   one of them is judged wrong even though it is a typo away. */
export function nearTitles(title, titles, max = 60){
  const t = squash(title), room = slack(t.length);
  const out = [];
  for (const o of titles){
    const k = squash(o);
    if (!k || k === t || Math.abs(k.length - t.length) > room) continue;
    if (distance(k, t) <= room) out.push(o);
    if (out.length >= max) break;
  }
  return out;
}

/* Autocomplete over a large public list: fold every title once up front. */
export const prepareTitles = titles => titles.map(title => ({ title, f: fold(title) }));

/* Titles whose words start with what was typed, best first. */
export function suggest(query, prepared, limit = 6){
  const q = fold(query);
  if (!q) return [];
  const words = q.split(" ");
  const flat = q.replace(/ /g, "");
  const scored = [];
  for (const { title, f } of prepared){
    const fw = f.split(" ");
    const hit = words.every(w => fw.some(x => x.startsWith(w)));
    if (!hit && !f.replace(/ /g, "").includes(flat)) continue;
    scored.push({ title, rank: f.startsWith(q) ? 0 : hit ? 1 : 2, len: f.length });
  }
  return scored.sort((a, b) => a.rank - b.rank || a.len - b.len).slice(0, limit).map(x => x.title);
}
