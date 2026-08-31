export const de = s => { const t=document.createElement("textarea"); t.innerHTML=s||""; return t.value; };
/* iOS Safari enforces tight per-tab memory budgets (jetsam kills the tab and
   reloads the page mid-game); memory-heavy pipeline stages check this.
   iPadOS reports itself as MacIntel, hence the maxTouchPoints check. */
export const isIOS = typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
export const stripParens = s => s.replace(/[\(\[].*?[\)\]]/g,"").replace(/\s+/g," ").trim();
export const fmtScore = n => n % 1 ? `${Math.floor(n)}½` : String(n);
export const shuffle = a => { a=[...a]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };
export function safeUrl(u){
  if (typeof u !== "string") return null;
  if (/^https:\/\//i.test(u)) return u;
  if (/^http:\/\//i.test(u)) return "https://" + u.slice(7);
  return null;
}
