// Builds catalog.json from the iTunes Search API.
// Run: node scripts/build-catalog.mjs
// Requests are sequential with a delay to stay under Apple's ~20 req/min limit.

import { songKey } from "../src/lib/utils.js";
import { ITUNES_TERMS as TERMS, ITUNES_LANG_OK as LANG_OK, EXCLUDE_RX } from "../src/lib/constants.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function search(term, attempt = 0) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&country=IN&limit=50`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).results || [];
  } catch (e) {
    if (attempt >= 2) { console.error(`  FAILED ${term}: ${e.message}`); return []; }
    await sleep(5000 * (attempt + 1));
    return search(term, attempt + 1);
  }
}

const seen = new Set();
const tracks = [];
for (const [lang, terms] of Object.entries(TERMS)) {
  for (const term of terms) {
    const results = await search(term);
    let kept = 0;
    for (const s of results) {
      if (!s.previewUrl || !s.trackName) continue;
      if (EXCLUDE_RX.test(s.trackName)) continue;
      const g = (s.primaryGenreName || "").toLowerCase();
      if (!LANG_OK[lang].some(k => g.includes(k))) continue;
      const year = s.releaseDate ? new Date(s.releaseDate).getFullYear() : 0;
      if (year < 2000) continue;
      const key = songKey(s.trackName);
      if (seen.has(key)) continue;
      seen.add(key);
      kept++;
      tracks.push({
        title: s.trackName,
        artist: s.artistName || "Unknown artist",
        album: s.collectionName || "",
        art: s.artworkUrl100 ? s.artworkUrl100.replace("100x100", "400x400") : null,
        stream: s.previewUrl,
        duration: 30,
        year,
        lang,
      });
    }
    console.log(`${lang} | ${term}: ${results.length} results, ${kept} kept`);
    await sleep(3500);
  }
}

const byLang = tracks.reduce((m, t) => (m[t.lang] = (m[t.lang] || 0) + 1, m), {});
console.log(`Total: ${tracks.length}`, byLang);
if (tracks.length < 100) { console.error("Too few tracks; not writing catalog.json"); process.exit(1); }

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("../public/catalog.json", import.meta.url), JSON.stringify({ tracks }));
console.log("Wrote public/catalog.json");
