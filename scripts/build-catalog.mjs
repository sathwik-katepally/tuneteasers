// Builds catalog.json from the iTunes Search API.
// Run: node scripts/build-catalog.mjs
// Requests are sequential with a delay to stay under Apple's ~20 req/min limit.

const TERMS = {
  bolly: ["Arijit Singh","Pritam songs","Shreya Ghoshal hindi","A R Rahman hindi","Amit Trivedi","Vishal Shekhar","Sonu Nigam hindi","Atif Aslam hindi","Jubin Nautiyal","Mohit Chauhan","Sachin Jigar","Badshah hindi"],
  telugu: ["Sid Sriram telugu","Devi Sri Prasad hits","Thaman S telugu","Anirudh telugu songs","Mickey J Meyer telugu","Gopi Sundar telugu","M M Keeravani telugu","Armaan Malik telugu","Anurag Kulkarni","telugu hit songs","Kaala Bhairava","Mangli telugu"],
};
const LANG_OK = { bolly:["bollywood","hindi"], telugu:["telugu","tollywood"] };
const EXCLUDE_RX = /(remix|mashup|lo-?fi|slowed|reverb|medley|unplugged|acoustic|cover|karaoke|instrumental|\bbgm\b|jukebox|revisited|reprise|redux|\bclub\b|\bdj\b|mix\b|8d\b|sped up|lounge|\bversion\b)/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stripParens = s => s.replace(/[\(\[].*?[\)\]]/g,"").replace(/\s+/g," ").trim();

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
      const key = stripParens(s.trackName).toLowerCase();
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
