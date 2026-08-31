/* Song loading.
   Primary: JioSaavn mirror (full songs, snippets start at the intro).
   Fallback 1: catalog.json baked into the site (rebuilt weekly by CI, 30s hook clips).
   Fallback 2: live iTunes search, throttled to stay under Apple's rate limit. */
import { SAAVN_BASES, SAAVN_QUERIES, ITUNES_TERMS, ITUNES_LANG_OK, EXCLUDE_RX, ERAS, eraOf, SNIP_CLEAN_MAX } from "./constants.js";
import { de, stripParens, shuffle, safeUrl } from "./utils.js";
import { sanitizeTrack, loadPlayed, loadBlocked, normArtist, isBlocked, PLAY_COOLDOWN } from "./storage.js";
import { log, ms } from "./log.js";

let saavnBase = null;
async function saavnFetch(path){
  const bases = saavnBase ? [saavnBase] : SAAVN_BASES;
  for (const b of bases){
    try {
      const ctl = new AbortController();
      const to = setTimeout(()=>ctl.abort(), 6000);
      const r = await fetch(b + path, { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && (j.data || j.results)){ saavnBase = b; return j; }
    } catch(e){}
  }
  return null;
}
const pickStream = dl => {
  if (!Array.isArray(dl)) return null;
  for (const q of ["96kbps","160kbps","48kbps","320kbps","12kbps"]){
    const hit = dl.find(x=>x.quality===q); if (hit && (hit.url||hit.link)) return hit.url||hit.link;
  }
  const any = dl.find(x=>x.url||x.link); return any ? (any.url||any.link) : null;
};
const pickArt = img => Array.isArray(img) && img.length ? (img[img.length-1].url||img[img.length-1].link||null) : null;

async function loadFromSaavn(langs){
  const jobs = [];
  for (const lang of langs) for (const q of shuffle(SAAVN_QUERIES[lang]).slice(0,7)) jobs.push({q,lang});
  const seen = new Set(); const pool = [];
  const results = await Promise.allSettled(jobs.map(j =>
    saavnFetch(`/search/songs?query=${encodeURIComponent(j.q)}&limit=40`).then(r=>({r, lang:j.lang}))
  ));
  for (const res of results){
    if (res.status!=="fulfilled" || !res.value.r) continue;
    const lang = res.value.lang;
    const list = res.value.r.data?.results || res.value.r.results || [];
    for (const s of list){
      const name = de(s.name || s.title || "");
      if (!name) continue;
      if ((s.language||"").toLowerCase() !== (lang==="bolly"?"hindi":"telugu")) continue;
      const year = parseInt(s.year) || 0;
      if (year < 2000) continue;
      if (EXCLUDE_RX.test(name)) continue;
      const stream = safeUrl(pickStream(s.downloadUrl));
      if (!stream) continue;
      const key = stripParens(name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const artists = (s.artists?.primary || []).map(a=>de(a.name)).filter(Boolean);
      pool.push(sanitizeTrack({
        title:name, artist:artists.slice(0,3).join(", ")||"Unknown artist",
        album:de(s.album?.name||""), art:pickArt(s.image), stream,
        duration:parseInt(s.duration)||200, year, lang,
      }));
    }
  }
  return pool.filter(Boolean);
}

async function loadCatalog(langs){
  try {
    const r = await fetch("./catalog.json", { cache:"no-cache" });
    if (!r.ok) return [];
    const j = await r.json();
    const tracks = (Array.isArray(j.tracks) ? j.tracks : []).map(t=>sanitizeTrack({ ...t, hook:true })).filter(Boolean);
    return tracks.filter(t => langs.includes(t.lang));
  } catch(e){ return []; }
}

function jsonp(url){
  return new Promise((resolve,reject)=>{
    const cb = "cb_"+Math.random().toString(36).slice(2);
    window[cb] = data => { resolve(data); cleanup(); };
    const s = document.createElement("script");
    s.src = url + "&callback=" + cb;
    s.onerror = () => { reject(new Error("jsonp failed")); cleanup(); };
    function cleanup(){ delete window[cb]; s.remove(); }
    document.body.appendChild(s);
    setTimeout(()=>{ if(window[cb]){ reject(new Error("timeout")); cleanup(); } }, 8000);
  });
}
const itunesSearch = (term, limit) => {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&country=IN&limit=${limit||40}`;
  return fetch(url).then(r=>r.json()).catch(()=> jsonp(url));
};

async function loadFromItunes(langs){
  const jobs = [];
  // Keep the request count low: iTunes rate-limits around 20 searches/min per IP,
  // and a failed attempt needs headroom for the user to retry within a minute.
  for (const lang of langs) for (const t of shuffle(ITUNES_TERMS[lang]).slice(0, langs.length>1 ? 5 : 8)) jobs.push({t,lang});
  const settled = await Promise.allSettled(jobs.map(j=>itunesSearch(j.t)));
  const seen = new Set(); const pool = [];
  settled.forEach((res, idx) => {
    if (res.status!=="fulfilled" || !res.value || !res.value.results) return;
    const lang = jobs[idx].lang;
    for (const s of res.value.results){
      if (!s.previewUrl || !s.trackName) continue;
      if (EXCLUDE_RX.test(s.trackName)) continue;
      const g = (s.primaryGenreName||"").toLowerCase();
      if (!ITUNES_LANG_OK[lang].some(k=>g.includes(k))) continue;
      const year = s.releaseDate ? new Date(s.releaseDate).getFullYear() : 0;
      if (year < 2000) continue;
      const key = stripParens(s.trackName).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(sanitizeTrack({
        title:s.trackName, artist:s.artistName||"Unknown artist", album:s.collectionName||"",
        art:s.artworkUrl100 ? s.artworkUrl100.replace("100x100","400x400") : null,
        stream:s.previewUrl, duration:30, year, lang, hook:true,
      }));
    }
  });
  return pool.filter(Boolean);
}

/* The offline-scored instrumental-window index (see docs/audio.md).
   Fetched fresh per crate build; absence is normal (index not built yet,
   or fetch failed) and simply means no track gets a verified window. */
async function loadSnips(){
  try {
    const r = await fetch("./snips.json", { cache:"no-cache" });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.snips && typeof j.snips === "object") ? j.snips : null;
  } catch(e){ return null; }
}

/* Returns { queue, source } or { error: "load" | "thin" }. */
export async function buildCrate(mix, eras, sound){
  const t0 = performance.now();
  const langs = mix==="both" ? ["bolly","telugu"] : [mix];
  const key = t => stripParens(t.title).toLowerCase();
  const snipsP = loadSnips();
  let pool = await loadFromSaavn(langs);
  let source = "saavn";
  const tiers = { saavn: pool.length };
  if (pool.length < 10){
    const keys = new Set(pool.map(key));
    const backup = (await loadCatalog(langs)).filter(t=>!keys.has(key(t)));
    tiers.catalog = backup.length;
    if (!pool.length) source = "catalog";
    pool = pool.concat(backup);
  }
  if (pool.length < 10){
    const keys = new Set(pool.map(key));
    const live = (await loadFromItunes(langs)).filter(t=>!keys.has(key(t)));
    tiers.live = live.length;
    if (!pool.length) source = "live";
    pool = pool.concat(live);
  }
  // Annotate verified instrumental windows: t.snip = window start in seconds,
  // set only when the song's index entry is clean enough to trust raw playback.
  const snips = await snipsP;
  let snipped = 0;
  if (snips) for (const t of pool){
    const e = snips[key(t)];
    if (Array.isArray(e) && Number.isFinite(e[0]) && e[1] < SNIP_CLEAN_MAX){ t.snip = Math.max(0, Math.floor(e[0])); snipped++; }
  }
  log("crate", { mix, source, ...tiers, snips: snips ? "ok" : "none", snipped, ms: ms(t0) });
  if (pool.length < 10) return { error:"load" };
  if (Array.isArray(eras) && eras.length && eras.length < ERAS.length)
    pool = pool.filter(t => eras.includes(eraOf(t.year)));
  const blocked = new Set(loadBlocked().map(normArtist));
  if (blocked.size) pool = pool.filter(t => !isBlocked(t, blocked));
  if (pool.length < 10) return { error:"thin" };
  // Recently played songs (this device) sit out; when the fresh pool runs thin,
  // repeats come back least-recently-played first, queued after all fresh songs.
  const played = loadPlayed();
  const now = Date.now();
  const fresh = [], stale = [];
  for (const t of pool) ((now - (played[key(t)] || 0)) > PLAY_COOLDOWN ? fresh : stale).push(t);
  stale.sort((a,b) => (played[key(a)]||0) - (played[key(b)]||0));
  let queue = fresh.length >= 15 ? shuffle(fresh) : shuffle(fresh).concat(stale);
  // Music-only eligibility (adaptive): with enough verified tracks the whole
  // game plays raw "snip" windows; when verified tracks are scarce they lead
  // the queue and unverified ones follow, playing through the muffle graph.
  if (sound === "inst"){
    const verified = queue.filter(t => Number.isFinite(t.snip));
    if (verified.length >= 15) queue = verified;
    else queue = verified.concat(queue.filter(t => !Number.isFinite(t.snip)));
  }
  return { queue, source };
}
