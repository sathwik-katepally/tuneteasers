/* Error reporting's front door (docs/testing-and-deploy.md, Error reporting).
   Everything that talks to Sentry is in sentry.ts, a chunk that only a build
   with a DSN downloads, and only after the first render. */
let screen = "";
export const setScreen = (name: string) => { screen = name; };
export const screenName = () => screen;

let sdk: Promise<typeof import("./sentry")> | undefined;
const load = () => (sdk ??= import("./sentry"));

// A chunk that fails to load (offline, a deploy in between) must not become an error of its own.
export function startReporting(){
  if (__SENTRY_DSN__) setTimeout(() => { load().catch(() => {}); });
}
export function reportCrash(error: unknown){
  if (__SENTRY_DSN__) load().then(m => m.reportCrash(error), () => {});
}
