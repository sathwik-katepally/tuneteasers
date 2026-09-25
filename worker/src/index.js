/* Self-hosted JioSaavn search for TuneTeasers.
   Serves GET /api/search/songs?query=&limit=&page= in the saavn.dev response
   shape (the subset the client reads), so it is interchangeable with the
   public mirrors listed after it in SAAVN_BASES. */
import forge from "node-forge/lib/forge.js";
import "node-forge/lib/des.js";

const ORIGIN = "https://www.jiosaavn.com/api.php";
// JioSaavn's web player ships this DES key; media URLs are encrypted with it.
const MEDIA_KEY = "38346591";
const QUALITIES = ["12", "48", "96", "160", "320"];
const EDGE_TTL = 6 * 3600;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });

const https = u => (typeof u === "string" ? u.replace(/^http:\/\//i, "https://") : "");

function decryptMediaUrl(enc){
  try {
    const d = forge.cipher.createDecipher("DES-ECB", forge.util.createBuffer(MEDIA_KEY));
    d.start({ iv: "" });
    d.update(forge.util.createBuffer(forge.util.decode64(enc)));
    return d.finish() ? d.output.getBytes() : "";
  } catch {
    return "";
  }
}

function downloadUrls(info){
  const base = https(decryptMediaUrl(info?.encrypted_media_url || ""));
  if (!/_96\.mp4$/.test(base)) return [];
  const max = info["320kbps"] === "true" ? 320 : 160;
  return QUALITIES.filter(q => +q <= max)
    .map(q => ({ quality: `${q}kbps`, url: base.replace(/_96\.mp4$/, `_${q}.mp4`) }));
}

const images = url => {
  const u = https(url);
  if (!u) return [];
  return ["50x50", "150x150", "500x500"].map(q => ({ quality: q, url: u.replace(/\d+x\d+/, q) }));
};

const artists = list => (Array.isArray(list) ? list : []).map(a => ({ id: a.id, name: a.name }));

function toSong(s){
  const info = s.more_info || {};
  return {
    id: s.id,
    name: s.title,
    type: s.type,
    year: s.year || null,
    duration: parseInt(info.duration) || null,
    language: s.language,
    album: { id: info.album_id || null, name: info.album || "" },
    artists: { primary: artists(info.artistMap?.primary_artists) },
    image: images(s.image),
    downloadUrl: downloadUrls(info),
  };
}

async function searchSongs(url){
  const query = (url.searchParams.get("query") || "").trim().slice(0, 100);
  if (!query) return json({ success: false, message: "query is required" }, 400);
  const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, parseInt(v) || dflt));
  const limit = clamp(url.searchParams.get("limit"), 1, 50, 10);
  const page = clamp(url.searchParams.get("page"), 1, 20, 1);

  const up = new URL(ORIGIN);
  up.search = new URLSearchParams({
    __call: "search.getResults", _format: "json", _marker: "0",
    api_version: "4", ctx: "web6dot0", q: query, n: String(limit), p: String(page),
  });
  const r = await fetch(up, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return json({ success: false, message: `upstream ${r.status}` }, 502);
  // api.php answers with text/html and occasionally a non-JSON error page.
  let j;
  try { j = JSON.parse(await r.text()); } catch { return json({ success: false, message: "upstream sent non-JSON" }, 502); }
  const results = (Array.isArray(j.results) ? j.results : []).filter(s => s.type === "song").map(toSong);
  return json(
    { success: true, data: { total: parseInt(j.total) || 0, start: parseInt(j.start) || 0, results } },
    200,
    { "cache-control": `public, max-age=3600, s-maxage=${EDGE_TTL}` },
  );
}

export default {
  async fetch(request, env, ctx){
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ success: false, message: "method not allowed" }, 405);
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ success: true });
    if (url.pathname !== "/api/search/songs") return json({ success: false, message: "not found" }, 404);

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    let res;
    try { res = await searchSongs(url); } catch (e) { res = json({ success: false, message: String(e?.message || e) }, 502); }
    if (res.status === 200 && res.headers.get("cache-control")) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
