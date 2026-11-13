/* Client error reporting to Sentry (docs/testing-and-deploy.md, Error
   reporting). Loaded by report.ts only in a build that has a DSN.
   The app has no accounts, and a group invite, a room code, names and song
   titles must never reach a server that is not theirs. So nothing the SDK
   gathers is sent as it is: beforeSend builds a new event from the fields
   listed here, and the transport refuses everything else. */
import {
  BrowserClient, captureException, captureMessage, defaultStackParser, getCurrentScope,
  globalHandlersIntegration, makeFetchTransport,
  type ErrorEvent, type EventHint, type Exception, type StackFrame,
} from "@sentry/browser";
import { logDump, onLog } from "./log.js";
import { screenName } from "./report";

// Per page load, so a dead CDN or an error in a timer loop cannot use up the month's quota.
const MAX_EVENTS = 10;
const MAX_STREAM_REPORTS = 3;
const LOG_TAIL = 30;

/* The debug-log entries an event may quote, and the fields of each. Every
   listed field holds a number, a flag or one of a few fixed words; titles,
   names, messages and the stream ids (URL tails) are left out. An entry or a
   field that is not listed here is not sent. */
const LOG_FIELDS: Record<string, string[]> = {
  boot: [], pagehide: ["persisted"], "js-error": [], "js-rejection": [], "go-home": [],
  crate: ["sound", "songs", "source", "corpus", "saavn", "catalog", "snips", "snipped", "cooldown", "ms"],
  snippet: ["rung", "from", "to", "sound"],
  play: ["mode", "snip", "offset", "secs", "ctx"],
  "element-play": ["offset", "secs"],
  "element-fail": ["err"],
  "snip-fail": [],
  "sfx-fail": ["name"],
  pass: ["to"],
  skip: ["room"],
  "room-song": ["n", "state", "rung", "phase", "songNo"],
  "room-refused": ["code", "phase"],
  "room-create-fail": [],
};
// Lowercase only, so a room code (four capitals) can never pass as one of the fixed words.
const plain = (v: unknown) => (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || (typeof v === "string" && /^[a-z][a-z _-]{0,15}$/.test(v));

// The buffer is read back from localStorage on boot, so its shape is checked, not trusted.
function logTail(): string[] {
  const out: string[] = [];
  for (const e of logDump().slice(-LOG_TAIL)){
    if (!e || typeof e.tag !== "string" || !Object.hasOwn(LOG_FIELDS, e.tag)) continue;
    const at = /^\d\d:\d\d:\d\d\.\d{3}$/.test(e.t) ? e.t : "";
    out.push([at, e.tag, ...LOG_FIELDS[e.tag].filter(k => plain(e[k])).map(k => `${k}=${e[k]}`)].join(" ").trim());
  }
  return out;
}

/* An error message is free text, so it cannot be allowlisted. Everything from
   the first quote on is dropped (engines quote the data they choked on, a
   name or a title included), then URLs, link fragments and query pairs, long
   tokens (an invite, a seat key) and four capitals (a room code). */
const scrub = (text: unknown) => String(text).slice(0, 2000)
  .replace(/(["`]|\B'|'\B)[\s\S]*$/, "[cut]")
  .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "[url]")
  .replace(/[#?&][^\s=&]*=\S*/g, "[param]")
  .replace(/(?:[\w-]+\.)*[\w-]{20,}(?:\.[\w-]+)*/g, "[token]")
  .replace(/\b[A-Z]{4}\b/g, "[code]")
  .slice(0, 200);

const word = (v: unknown, rx: RegExp, or: string) => (typeof v === "string" && rx.test(v) ? v : or);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// A frame's file is the page itself for an inline script or a bare onerror, link fragment and all, so only a built asset's name is kept.
const frame = (f: StackFrame): StackFrame => ({
  filename: /\/(assets\/[\w.-]+\.js)$/.exec(String(f.filename).split(/[?#]/)[0])?.[1] ?? "other",
  function: word(f.function, /^[\w$.<>[\] ]{1,80}$/, "?"),
  lineno: count(f.lineno),
  colno: count(f.colno),
  in_app: f.in_app !== false,
});

const exception = (x: Exception, text: boolean): Exception => ({
  type: word(x.type, /^\w{1,60}$/, "Error"),
  value: text ? scrub(x.value ?? "") : "[not an Error]",
  ...(x.stacktrace?.frames ? { stacktrace: { frames: x.stacktrace.frames.slice(-50).map(frame) } } : {}),
  ...(x.mechanism ? { mechanism: { type: word(x.mechanism.type, /^[\w.]{1,60}$/, "generic"), handled: x.mechanism.handled !== false } } : {}),
});

const rebuilt = new WeakSet<object>();
// The stream messages this file writes itself, out of allowlisted words.
const own = new Set<string>();
let events = 0;

function rebuild(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (++events > MAX_EVENTS) return null;
  // A thrown or rejected value that is not an Error is the text (a string) or the SDK writes one out of it (an object's keys), so none of it is kept.
  const thrown = hint.originalException;
  const text = thrown === undefined || thrown instanceof Error || (typeof thrown === "string" && own.has(thrown));
  const out: ErrorEvent = {
    type: undefined,
    event_id: word(event.event_id, /^[0-9a-f]{32}$/, "") || undefined,
    timestamp: count(event.timestamp),
    platform: "javascript",
    level: event.level === "warning" ? "warning" : "error",
    release: __BUILD_SHA__,
    ...(event.message ? { message: text ? scrub(event.message) : "[not an Error]" } : {}),
    ...(event.exception?.values ? { exception: { values: event.exception.values.slice(0, 3).map(x => exception(x, text)) } } : {}),
    tags: { screen: /^[a-z]+/.exec(screenName())?.[0] ?? "none" },
    extra: { log: logTail() },
    // Sentry reads the browser and the OS out of this.
    request: { headers: { "User-Agent": navigator.userAgent } },
  };
  rebuilt.add(out);
  return out;
}

export const reportCrash = (error: unknown) => { captureException(error); };

const client = new BrowserClient({
  dsn: __SENTRY_DSN__,
  release: __BUILD_SHA__,
  stackParser: defaultStackParser,
  // The whole list: no breadcrumbs, page URL, session, tracing, replay or feedback integrations.
  integrations: [globalHandlersIntegration()],
  maxBreadcrumbs: 0,
  attachStacktrace: false,
  sendClientReports: false,
  // Tells Sentry not to take the visitor's IP address from the connection either.
  dataCollection: { userInfo: false },
  beforeSend: rebuild,
  /* The SDK sends some things past beforeSend (its own internal errors,
     sessions, client reports), and a later version may add more. Only an
     envelope holding nothing but an event rebuilt above leaves the page. */
  transport: options => {
    const transport = makeFetchTransport(options);
    return {
      ...transport,
      send: envelope => ((envelope[1] as [{ type?: string }, unknown][]).every(([head, body]) => head.type === "event" && rebuilt.has(body as object))
        ? transport.send(envelope) : Promise.resolve({})),
    };
  },
});
getCurrentScope().setClient(client);
client.init();

let streamReports = 0;
onLog((e: { tag: string; err?: unknown }) => {
  if ((e.tag !== "element-fail" && e.tag !== "snip-fail") || ++streamReports > MAX_STREAM_REPORTS) return;
  const message = `stream ${e.tag}${plain(e.err) ? ` ${e.err}` : ""}`;
  own.add(message);
  captureMessage(message, "warning");
});
