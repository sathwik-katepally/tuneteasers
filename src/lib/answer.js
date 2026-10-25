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
  [/(^| )y(?=e)/g, "$1"], [/(^| )nahi?n?(?= |$)/g, "$1nai"], [/ph/g, "f"], [/chh|ch/g, "c"], [/([kgjtdbs])h/g, "$1"],
  [/w/g, "v"], [/z/g, "j"], [/q/g, "k"],
  [/ee|ii|ie/g, "i"], [/oo|uu/g, "u"], [/aa/g, "a"], [/ai|ei|ay/g, "e"],
  [/([a-z])\1+/g, "$1"],
];

const plain = s => songKey(displayTitle(String(s || "")).normalize("NFKD").replace(/\p{M}/gu, ""));

function foldKey(t){
  for (const [rx, to] of FOLDS) t = t.replace(rx, to);
  return t;
}
const fold = s => foldKey(plain(s));
const squash = s => fold(s).replace(/ /g, "");

/* A version of a song is still that song: "Dus Bahane 2.0" is "Dus Bahane",
   "Dhadak Title Track" is "Dhadak". songKey already drops bracketed and
   " - Reprise" style suffixes; these are the markers left inside the title. */
const VERSION = /\b(?:title track|feat\b.*|ft\b.*|remix|reprise|unplugged|version|lofi|male|female|sad|duet|\d+)\b/g;
const base = s => foldKey(plain(s).replace(VERSION, " ")).replace(/ /g, "");

/* Romanised vowels are the least fixed part of a spelling ("Nuvvasthanante"
   / "Nuvvosthanante", "Chaleya" / "Chalya"), so a vowel swapped, added or
   dropped costs half a typo. */
const VOWELS = new Set("aeiou");
const cost = c => (VOWELS.has(c) ? 0.5 : 1);
function distance(a, b){
  if (a === b) return 0;
  let prev = [0];
  for (let j = 1; j <= b.length; j++) prev[j] = prev[j - 1] + cost(b[j - 1]);
  for (let i = 1; i <= a.length; i++){
    const row = [prev[0] + cost(a[i - 1])];
    for (let j = 1; j <= b.length; j++){
      const x = a[i - 1], y = b[j - 1];
      const swap = x === y ? 0 : VOWELS.has(x) && VOWELS.has(y) ? 0.5 : 1;
      row[j] = Math.min(prev[j] + cost(x), row[j - 1] + cost(y), prev[j - 1] + swap);
    }
    prev = row;
  }
  return prev[b.length];
}

const slack = len => (len <= 4 ? 0 : len <= 8 ? 1 : len <= 14 ? 2 : 3);

/* Right when the folded guess is the title or a version of it, or a typo
   away from it, unless the guess is exactly another title on the show's list
   (a deliberate wrong pick that happens to look alike). */
function matches(guess, g, title, others){
  const t = squash(title);
  if (!t) return false;
  if (g === t) return true;
  const bt = base(title);
  if (bt && base(guess) === bt) return true;
  if (others.some(o => { const k = squash(o); return k && k !== t && k === g; })) return false;
  return distance(g, t) <= slack(t.length);
}

/* songKey keeps only what comes before " - " ('Song - Reprise'), but some
   titles have the dash inside ("Dard - E - Disco") or come as
   "Film - Song" ("Dhurandhar The Revenge - Aari Aari"), so the whole title
   counts too, and the part after a film's name. */
const DASH = /\s+[-\u2013\u2014|]\s+/;
export function isCorrect(guess, title, others = [], film = ""){
  const g = squash(guess);
  if (!g) return false;
  const shown = displayTitle(String(title || ""));
  const forms = [title];
  if (DASH.test(shown)){
    const [head, ...rest] = shown.split(DASH);
    forms.push(shown.split(DASH).join(" "));
    if (film && squash(head) === squash(film)) forms.push(rest.join(" "));
  }
  return forms.some(t => matches(guess, g, t, others));
}

/* The film, for part of the points: its name or a typo away from it.
   songKey drops "(Original Motion Picture Soundtrack)" and " - Single". */
export function isFilm(guess, film){
  const g = squash(guess), f = squash(film);
  if (!g || !f) return false;
  const bf = base(film);
  return g === f || (!!bf && base(guess) === bf) || distance(g, f) <= slack(f.length);
}

/* Titles that isCorrect would take as a typo of `title`. The host sends
   these to the room with each song, so a guess that is exactly one of them
   is judged wrong even though it is a typo away. Entries from the song's own
   film are left out: there they are the same song spelled another way. */
export function nearTitles(title, film, entries, max = 60){
  const t = squash(title), room = slack(t.length), own = squash(film);
  const out = [];
  for (const o of entries){
    if (o.film) continue;
    const k = squash(o.title);
    if (!k || k === t || Math.abs(k.length - t.length) > room * 2) continue;
    if (own && o.films.some(f => squash(f) === own)) continue;
    if (distance(k, t) <= room) out.push(o.title);
    if (out.length >= max) break;
  }
  return out;
}

/* Autocomplete over a large public list: normalise every entry once up
   front, plainly, folded and as consonants only. Folding alone would lose a
   half-typed word ("ha" no longer starts "hain" once that folds to "hen");
   the plain form alone would miss a spelling variant; the consonants find a
   title through a swapped vowel ("nuvvos" for "Nuvvasthanante"). */
const bones = s => s.replace(/[aeiou]/g, "");
export const prepareTitles = entries => entries.map(e => {
  const f = fold(e.title);
  return { ...e, forms: [plain(e.title), f, bones(f)] };
});

/* A run of letters anywhere is matched on the plain form only: folded,
   "shake it like shammi" holds "kesa". */
function rankIn(form, q, anywhere = true){
  if (form.startsWith(q)) return 0;
  const words = q.split(" "), fw = form.split(" ");
  if (words.every(w => fw.some(x => x.startsWith(w)))) return 1;
  return anywhere && form.replace(/ /g, "").includes(q.replace(/ /g, "")) ? 2 : 3;
}

/* Entries matching what was typed, best first: whole-title prefix, then every
   word a prefix of some word, then a run of letters anywhere, then the same
   by consonants only. Songs come before films at the same rank. */
export function suggest(query, prepared, limit = 6){
  const p = plain(query), f = fold(query), b = bones(f);
  if (!p && !f) return [];
  const fq = f.replace(/ /g, ""), loose = b.replace(/ /g, "").length >= 3;
  const scored = [];
  for (const e of prepared){
    const rank = Math.min(rankIn(e.forms[0], p || f), rankIn(e.forms[1], f || p, false));
    if (rank < 3) scored.push({ e, rank: rank * 2 + (e.film ? 1 : 0), near: 0, len: e.forms[0].length });
    // Through a swapped vowel: closest to what was typed first.
    else if (loose && e.forms[2].replace(/ /g, "").startsWith(b.replace(/ /g, "")))
      scored.push({ e, rank: 6 + (e.film ? 1 : 0), near: distance(fq, e.forms[1].replace(/ /g, "").slice(0, fq.length)), len: e.forms[0].length });
  }
  return scored.sort((x, y) => x.rank - y.rank || x.near - y.near || x.len - y.len).slice(0, limit).map(x => x.e);
}
