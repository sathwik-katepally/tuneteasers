import s from "./Chooser.module.css";

export function Chooser({ options }: { options: { id: string; name: string; idea: string }[] }){
  return (
    <main className={s.root}>
      <h1 className={s.title}>Landing page options</h1>
      <ol className={s.list}>
        {options.map(o => (
          <li key={o.id}>
            <a className={s.card} href={`?proto=${o.id}`}>
              <span className={s.letter}>{o.id.toUpperCase()}</span>
              <span>
                <b className={s.name}>{o.name}</b>
                <span className={s.idea}>{o.idea}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </main>
  );
}
