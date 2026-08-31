/* On-device diagnostics overlay. Enable with ?debug=1 in the URL (sticky via
   localStorage; ?debug=0 turns it off). Shows the pipeline log live, with
   copy-to-clipboard so a phone user can paste evidence into a bug report. */
import { useEffect, useState } from "preact/hooks";
import { logDump, logClear, onLog } from "../lib/log.js";

function debugEnabled(){
  try {
    const q = new URLSearchParams(location.search).get("debug");
    if (q === "1") localStorage.setItem("tt_debug", "1");
    if (q === "0") localStorage.removeItem("tt_debug");
    return localStorage.getItem("tt_debug") === "1";
  } catch(e){ return false; }
}

const fmt = e => {
  const { n, t, tag, ...rest } = e;
  const kv = Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(" ");
  return `${t} ${tag}${kv ? " " + kv : ""}`;
};

export function DebugLog(){
  const [on] = useState(debugEnabled);
  // ?debug=1 in the URL is an explicit "show me the logs now": open the panel
  // immediately instead of relying on the fab, which real iPhones hide behind
  // the browser's bottom toolbar (fixed-bottom elements sit under it).
  const [open, setOpen] = useState(() => {
    try { return new URLSearchParams(location.search).get("debug") === "1"; } catch(e){ return false; }
  });
  const [copied, setCopied] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => { if (on && open) return onLog(() => bump(x => x + 1)); }, [on, open]);
  if (!on) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logDump().map(fmt).join("\n"));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch(e){}
  };
  if (!open) return <button class="dbg-fab" onClick={() => setOpen(true)}>log</button>;
  return (
    <div class="dbg-panel">
      <div class="dbg-bar">
        <span>pipeline log ({logDump().length})</span>
        <button onClick={copy}>{copied ? "copied" : "copy"}</button>
        <button onClick={() => { logClear(); bump(x => x + 1); }}>clear</button>
        <button onClick={() => setOpen(false)}>close</button>
      </div>
      <pre class="dbg-body">{logDump().slice(-60).map(fmt).join("\n")}</pre>
    </div>
  );
}
