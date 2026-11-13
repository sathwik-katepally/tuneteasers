/* build-corpus.mjs's size check against the committed corpus, in its own
   module because importing the build script starts a build. */
import fs from "node:fs";

/* An upstream that answers with half of a language still clears the absolute
   floor, so each language must also keep minShare of the songs the committed
   corpus holds for it. A language the committed corpus lacks passes. */
export function shrunkLanguages(counts, committedPath, minShare){
  const committed = JSON.parse(fs.readFileSync(committedPath, "utf8"));
  const col = committed.cols.indexOf("language");
  const before = {};
  for (const row of committed.songs) before[row[col]] = (before[row[col]] || 0) + 1;
  return Object.keys(counts)
    .filter(lang => counts[lang] < (before[lang] || 0) * minShare)
    .map(lang => `only ${counts[lang]} ${lang} songs (< ${minShare} of the ${before[lang]} in ${committedPath})`);
}
