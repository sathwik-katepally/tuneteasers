import s from "./Crashed.module.css";

/* What the error boundary in main.tsx shows when a render throws. It sits
   outside App, so it uses nothing a crash there could take down with it. */
export function Crashed(){
  return (
    <main className={s.wrap} role="alert">
      <p className={s.eyebrow}>Intermission</p>
      <h1 className={s.title}>Something went wrong</h1>
      <p className={s.text}>The page ran into a problem. Reload to carry on. Your game is saved.</p>
      <button type="button" className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
    </main>
  );
}
