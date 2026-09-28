import { useEffect, useMemo, useState } from "react";
import { GroupError, localHistoryCount, useGroup } from "../lib/group";
import { loadBlocked } from "../lib/storage.js";
import {
  BROKEN_TICKET, PasskeyError, addPasskey, adoptTicket, createTicket, deleteTicket, forgetTicket, passkeysSupported, previewTicket,
  recoverWithPasskey, ticketLink, useMe, type Prefs,
} from "../lib/me";
import { NAME_MAX } from "../lib/config";
import { Qr } from "./Qr";
import s from "./TicketPanel.module.css";

type View = "summary" | "create" | "move" | "recover" | "forget" | "delete" | "arrive";

interface Props {
  /* A #me= link opened on this phone: the ticket to take over, or BROKEN_TICKET. */
  moveTicket: string;
  clearMoveTicket: () => void;
  onPrefs: (prefs: Prefs | null) => void;
}

const message = (e: unknown) =>
  e instanceof PasskeyError ? e.message
    : e instanceof GroupError
      ? e.status === 0 ? "Couldn't reach the ticket office. Check the connection and try again."
        : e.status === 401 || e.status === 403 ? "That ticket doesn't work any more. It may have been deleted, or recovered on another phone."
        : e.status === 429 ? "Too many tries. Wait a minute and try again."
        : e.message
      : "Something went wrong. Try again.";

/* Home-screen card for the personal ticket (docs/tickets.md): make one, move
   it to another phone by QR or link, recover it with a passkey, remove it
   from this phone or delete it. With no ticket the game is unchanged. */
export function TicketPanel({ moveTicket, clearMoveTicket, onPrefs }: Props){
  const { me, sync, pending } = useMe();
  const { group } = useGroup();
  const heard = useMemo(localHistoryCount, [group]);
  const offer = !!group || heard > 0;
  const [view, setView] = useState<View>(moveTicket ? "arrive" : "summary");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const go = (v: View) => { setError(""); setNote(""); setView(v); };

  async function run(task: () => Promise<void>, next: View){
    setBusy(true); setError("");
    try {
      await task();
      setView(next);
    } catch (e){
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  /* The passkey is asked for right after the ticket exists; a refused or
     unsupported prompt leaves a working ticket and says how to keep it safe. */
  async function makeTicket(name: string, withHistory: boolean){
    await createTicket(name, withHistory);
    onPrefs(null);
    if (!passkeysSupported()){ setNote("This browser can't make passkeys, so keep the move link somewhere safe."); return; }
    try {
      await addPasskey();
    } catch (e){
      setNote(e instanceof PasskeyError && e.kind === "cancelled" ? "No passkey yet. Create one below so a lost phone isn't a lost ticket."
        : `The passkey didn't take (${message(e)}). You can create one below.`);
    }
  }

  if (view === "arrive")
    return <ArriveCard ticket={moveTicket} current={me?.name ?? ""} busy={busy} error={error}
      onCancel={() => { clearMoveTicket(); go("summary"); }}
      onTake={ticket => run(async () => { onPrefs(await adoptTicket(ticket)); clearMoveTicket(); }, "summary")} />;
  if (view === "create")
    return <CreateForm busy={busy} error={error} current={me?.name ?? ""} onCancel={() => go("summary")}
      onCreate={(name, withHistory) => run(() => makeTicket(name, withHistory), "summary")} />;
  if (view === "recover") return (
    <section className={s.panel} aria-label="Recover a ticket">
      <span className={s.eyebrow}>Already have a ticket?</span>
      <p className={s.text}>Made it on another phone? Use the passkey you saved with it, or open the move link from that phone here.</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("summary")} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-teal" disabled={busy || !passkeysSupported()}
          onClick={() => run(async () => { onPrefs(await recoverWithPasskey()); }, "summary")}>{busy ? "Checking" : "Use my passkey"}</button>
      </div>
      {!passkeysSupported() && <p className={s.note}>This browser can't use passkeys. Open the move link from your other phone instead.</p>}
    </section>
  );

  // A phone that has never played and is in no group is not asked for a ticket
  // yet; only the way back to one made elsewhere stays in view.
  if (!me && !offer) return <button type="button" className={`link ${s.quiet}`} onClick={() => go("recover")}>Already have a ticket?</button>;
  if (!me) return (
    <section className={s.panel} aria-label="Ticket">
      <span className={s.eyebrow}>Your ticket</span>
      <p className={s.text}>Songs you've heard follow you, not the phone. Make a ticket with just a name, and any phone in your group, or any buzz-in show you join, skips what you've already had.</p>
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("recover")}>I have one</button>
        <button type="button" className="btn btn-teal" onClick={() => go("create")}>Make my ticket</button>
      </div>
    </section>
  );

  if (view === "move") return <MoveView ticket={me.ticket} name={me.name} onDone={() => go("summary")} />;

  if (view === "forget") return (
    <section className={s.panel} aria-label="Remove ticket from this phone">
      <span className={s.eyebrow}>Take {me.name}'s ticket off this phone?</span>
      <p className={s.text}>This phone goes back to its own song history. The ticket lives on: get it back with your passkey or a move link.</p>
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("summary")}>Keep it</button>
        <button type="button" className="btn btn-primary" onClick={() => { forgetTicket(); go("summary"); }}>Remove</button>
      </div>
      {sync !== "revoked" && <button type="button" className={`link ${s.linkBtn}`} onClick={() => go("delete")}>Delete the ticket for good</button>}
    </section>
  );

  if (view === "delete") return (
    <section className={s.panel} aria-label="Delete ticket">
      <span className={s.eyebrow}>Delete {me.name}'s ticket?</span>
      <p className={s.text}>Its song history, blocked artists and passkeys go with it, on every phone. This can't be undone.</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("summary")} disabled={busy}>Keep it</button>
        <button type="button" className="btn btn-primary" onClick={() => run(deleteTicket, "summary")} disabled={busy}>Delete</button>
      </div>
    </section>
  );

  const status = sync === "revoked" ? "Ticket no longer valid"
    : sync === "syncing" ? "Syncing"
    : pending ? `${pending} waiting to sync`
    : sync === "offline" ? "Offline"
    : "In sync";
  return (
    <section className={s.panel} aria-label="Ticket">
      <div className={s.top}>
        <span className={s.eyebrow}>Your ticket</span>
        <span className={`${s.status} ${sync === "revoked" ? s.bad : pending || sync === "offline" ? s.wait : ""}`}>{status}</span>
      </div>
      <p className={s.name}>{me.name}</p>
      {sync === "revoked" ? (
        <>
          <p className={s.text}>This ticket was deleted, or recovered on another phone. Remove it here to keep playing with this phone's own history.</p>
          <button type="button" className="btn btn-primary" onClick={() => { forgetTicket(); go("summary"); }}>Remove from this phone</button>
        </>
      ) : (
        <>
          {note && <p className={s.note}>{note}</p>}
          {error && <p className={s.error} role="alert">{error}</p>}
          <div className={s.row}>
            <button type="button" className="btn btn-cream" onClick={() => go("move")}>Move to a phone</button>
            {me.passkeys > 0
              ? <button type="button" className="btn btn-teal" disabled>{me.passkeys === 1 ? "Passkey saved" : `${me.passkeys} passkeys`}</button>
              : <button type="button" className="btn btn-teal" disabled={busy || !passkeysSupported()}
                  onClick={() => run(async () => { await addPasskey(); }, "summary")}>{busy ? "Creating" : "Create a passkey"}</button>}
          </div>
          {me.passkeys === 0 && <p className={s.text}>{passkeysSupported()
            ? "A passkey (Face ID, fingerprint or your phone's lock) gets the ticket back if you lose this phone."
            : "This browser can't make passkeys. Keep the move link somewhere safe instead."}</p>}
          <button type="button" className={`link ${s.linkBtn}`} onClick={() => go("forget")}>Remove from this phone</button>
        </>
      )}
    </section>
  );
}

function CreateForm({ busy, error, current, onCancel, onCreate }: {
  busy: boolean; error: string; current: string; onCancel: () => void; onCreate: (name: string, withHistory: boolean) => void;
}){
  const [name, setName] = useState("");
  const [withHistory, setWithHistory] = useState(true);
  const count = useMemo(localHistoryCount, []);
  const blocked = useMemo(() => loadBlocked().length, []);
  const clean = name.trim();
  const bring = [count ? `${count} recent songs` : "", blocked ? `${blocked} blocked ${blocked === 1 ? "artist" : "artists"}` : ""].filter(Boolean).join(" and ");
  return (
    <form className={s.panel} aria-label="Make a ticket" onSubmit={e => { e.preventDefault(); if (clean && !busy) onCreate(clean, withHistory); }}>
      <span className={s.eyebrow}>Make my ticket</span>
      <label className={s.field}>
        <span className={s.fieldLabel}>Your name</span>
        <input className={s.input} value={name} maxLength={NAME_MAX} placeholder="As the room knows you" autoFocus autoComplete="nickname"
          onChange={e => setName(e.target.value)} />
      </label>
      {bring && (
        <label className={s.check}>
          <input type="checkbox" checked={withHistory} onChange={e => setWithHistory(e.target.checked)} />
          <span>Bring this phone's {bring} onto the ticket</span>
        </label>
      )}
      <p className={s.text}>{current ? `This phone drops ${current}'s ticket and carries the new one.` : "Next you'll be asked for a passkey, so a lost phone isn't a lost ticket."}</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-teal" disabled={busy || !clean}>{busy ? "Making it" : "Make my ticket"}</button>
      </div>
    </form>
  );
}

function ArriveCard({ ticket: given, current, busy, error, onCancel, onTake }: {
  ticket: string; current: string; busy: boolean; error: string; onCancel: () => void; onTake: (ticket: string) => void;
}){
  const broken = given === BROKEN_TICKET;
  const ticket = broken ? "" : given;
  const [preview, setPreview] = useState<{ name?: string; error?: string }>({});
  useEffect(() => {
    if (!ticket) return;
    let live = true;
    previewTicket(ticket).then(name => live && setPreview({ name }), e => live && setPreview({ error: message(e) }));
    return () => { live = false; };
  }, [ticket]);
  const shownError = error || preview.error || (broken ? "That move link is incomplete. Open it again from the other phone." : "");
  return (
    <section className={s.panel} aria-label="Move a ticket here">
      <span className={s.eyebrow}>A ticket for this phone</span>
      <p className={s.text}>
        {preview.name ? <>Carry <b className={s.inline}>{preview.name}</b>'s ticket on this phone? Its song history and blocked artists come with it{current ? `, and ${current}'s ticket leaves this phone` : ""}.</>
          : preview.error || broken ? "This link can't be used." : "Reading the ticket…"}
      </p>
      {shownError && <p className={s.error} role="alert">{shownError}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Not now</button>
        <button type="button" className="btn btn-teal" disabled={busy || !ticket || !preview.name} onClick={() => onTake(ticket)}>{busy ? "Taking it" : "Take it"}</button>
      </div>
    </section>
  );
}

function MoveView({ ticket, name, onDone }: { ticket: string; name: string; onDone: () => void }){
  const link = ticketLink(ticket);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";
  async function copy(){
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      (document.getElementById("tt-ticket-link") as HTMLInputElement | null)?.select();
    }
  }
  return (
    <section className={s.panel} aria-label="Move the ticket">
      <span className={s.eyebrow}>Move {name}'s ticket</span>
      <div className={s.moveBody}>
        <Qr text={link} className={s.qr} label="Ticket QR code" />
        <p className={s.text}>Scan it with the other phone's camera, or send yourself the link. Whoever opens it holds your ticket, so don't post it around.</p>
      </div>
      <input id="tt-ticket-link" className={`${s.input} ${s.code}`} value={link} readOnly aria-label="Ticket link" onFocus={e => e.target.select()} />
      <div className={s.row}>
        <button type="button" className="btn btn-cream" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        {canShare
          ? <button type="button" className="btn btn-teal" onClick={() => navigator.share({ title: "Tune Teasers", text: "My Tune Teasers ticket", url: link }).catch(() => {})}>Share</button>
          : <button type="button" className="btn btn-teal" onClick={onDone}>Done</button>}
      </div>
      {canShare && <button type="button" className={`link ${s.linkBtn}`} onClick={onDone}>Done</button>}
    </section>
  );
}
