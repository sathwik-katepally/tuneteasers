export const de = s => { const t=document.createElement("textarea"); t.innerHTML=s||""; return t.value; };
/* iOS Safari enforces tight per-tab memory budgets (jetsam kills the tab and
   reloads the page mid-game); memory-heavy pipeline stages check this.
   iPadOS reports itself as MacIntel, hence the maxTouchPoints check. */
export const isIOS = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
/* Canonical identity key for a song title. Different sources title the same
   song differently — 'Srivalli [From "Pushpa - The Rise (Part - 01)"]',
   'Galatfehmi - From "Nadaaniyan"', "Single's Anthem" — so the key strips
   (nested) bracketed qualifiers, dash-separated suffixes, and punctuation.
   snips.json and tt_played are keyed by this; scripts/ import it too. */
export function songKey(s){
  let t = String(s||"");
  for (let p = ""; p !== t; ){ p = t; t = t.replace(/[\(\[][^()\[\]]*[\)\]]/g, " "); }
  return t
    .replace(/[\(\[].*$/, "")   // unbalanced leftover bracket
    .split(/\s+[-–—|]\s+/)[0]   // 'Song - From "Movie"' / 'Song - Reprise'
    .replace(/['’‘]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export const fmtScore = n => n % 1 ? `${Math.floor(n)}½` : String(n);
export const shuffle = a => { a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
export function safeUrl(u){
  if (typeof u !== "string") return null;
  if (/^https:\/\//i.test(u)) return u;
  if (/^http:\/\//i.test(u)) return "https://" + u.slice(7);
  return null;
}
