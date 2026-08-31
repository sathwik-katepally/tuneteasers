import { render } from "preact";
import { App } from "./app.jsx";
import { DebugLog } from "./components/DebugLog.jsx";
import { log } from "./lib/log.js";
import { mlReason } from "./lib/mlsep.js";
import "./styles.css";

// A "boot" with no preceding "pagehide" means the last page instance died
// without a clean exit (crash / jetsam kill / forced reload).
log("boot", { ml: mlReason(), ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 80) });

render(<><App /><DebugLog /></>, document.getElementById("root"));
