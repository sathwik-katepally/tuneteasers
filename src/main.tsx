import { createRoot } from "react-dom/client";
import "@fontsource/rozha-one/latin-400.css";
import "@fontsource/mukta/latin-400.css";
import "@fontsource/mukta/latin-700.css";
import "./styles/tokens.css";
import "./styles/global.css";
import { App } from "./app";
import { DebugLog } from "./components/DebugLog";
import { log } from "./lib/log.js";

// A "boot" with no preceding "pagehide" means the last page instance died
// without a clean exit (crash / jetsam kill / forced reload).
// The snips index is fetched per crate build; the "crate" log entry carries
// its status ("snips") and the verified-track count ("snipped").
log("boot", { ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 80) });

createRoot(document.getElementById("root")!).render(<><App /><DebugLog /></>);
