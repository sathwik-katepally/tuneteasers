/* The song languages, in display order: the one list the setup screen, the
   song loading, saved games and the Worker read. An id is JioSaavn's
   language name, which the corpus build (scripts/corpus.config.json) writes
   on every song. A film language's songs are named by song or film; a pop
   language's by song or artist. Adding a language is an entry here plus its
   playlists in the corpus config. */
export const LANGUAGES = [
  { id: "hindi", label: "Hindi", film: true },
  { id: "telugu", label: "Telugu", film: true },
  { id: "tamil", label: "Tamil", film: true },
  { id: "english", label: "English", film: false },
] as const;

export type Lang = (typeof LANGUAGES)[number]["id"];
export const LANG_IDS: readonly Lang[] = LANGUAGES.map(l => l.id);
const BY_ID = Object.fromEntries(LANGUAGES.map(l => [l.id, l])) as Record<Lang, (typeof LANGUAGES)[number]>;

export const langLabel = (l: Lang) => BY_ID[l].label;
export const isFilmLang = (l: Lang) => BY_ID[l].film;

/* A language from a save, a catalog row or a room message; "bolly" is Hindi's
   id from before ids were JioSaavn's names. */
export function langOf(v: unknown): Lang | null {
  if (v === "bolly") return "hindi";
  return (LANG_IDS as readonly unknown[]).includes(v) ? v as Lang : null;
}

/* A saved language choice: a list (or a group result's comma list), or the
   one word saves held before ("both" was Hindi and Telugu). Display order,
   no repeats; null when nothing in it is a language. */
export function langsOf(v: unknown): Lang[] | null {
  const raw = v === "both" ? ["hindi", "telugu"] : typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [];
  const set = new Set(raw.map(langOf));
  const langs = LANG_IDS.filter(l => set.has(l));
  return langs.length ? langs : null;
}

/* "Hindi", "Hindi and Tamil", "Hindi, Tamil and English". */
export function langsLabel(langs: readonly Lang[]): string {
  const names = langs.map(langLabel);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "";
}
