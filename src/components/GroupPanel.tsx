import { useEffect, useMemo, useState } from "react";
import {
  BROKEN_INVITE, GROUP_NAME_MAX, GroupError, createGroup, deleteGroup, inviteLink, joinGroup, leaveGroup,
  localHistoryCount, parseInvite, previewInvite, useGroup,
} from "../lib/group";
import { linkCurrentGroup, unlinkGroup } from "../lib/me";
import { Qr } from "./Qr";
import s from "./GroupPanel.module.css";

type View = "summary" | "create" | "join" | "invite" | "leave" | "delete";

interface Props {
  invite: string;
  clearInvite: () => void;
  showPastGames: () => void;
}

const message = (e: unknown) =>
  e instanceof GroupError
    ? e.status === 0 ? "Couldn't reach the group. Check the connection and try again."
      : e.status === 401 || e.status === 403 ? "That invite doesn't work. The group may have been deleted."
      : e.status === 429 ? "Too many tries. Wait a minute and try again."
      : e.message
    : "Something went wrong. Try again.";

/* Home-screen card for cross-phone sync: make or join a group, share its
   invite, open past shows, leave. Invisible to the game itself; with no group
   everything stays on this phone as before. */
export function GroupPanel({ invite, clearInvite, showPastGames }: Props){
  const { group, pending, sync } = useGroup();
  const [view, setView] = useState<View>(invite ? "join" : "summary");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = (v: View) => { setError(""); setView(v); };

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

  if (view === "join")
    return <JoinForm invite={invite} current={group?.name ?? ""} currentId={group?.id ?? ""} busy={busy} error={error}
      onCancel={() => { clearInvite(); go("summary"); }}
      onJoin={(code, withHistory) => run(async () => { await joinGroup(code, withHistory); clearInvite(); await linkCurrentGroup(); }, "summary")} />;
  if (view === "create")
    return <CreateForm busy={busy} error={error} onCancel={() => go("summary")}
      onCreate={(name, withHistory) => run(async () => { await createGroup(name, withHistory); await linkCurrentGroup(); }, "invite")} />;

  if (!group) return (
    <section className={s.panel} aria-label="Group">
      <span className={s.eyebrow}>More than one phone?</span>
      <p className={s.text}>Put them in a group. No phone repeats a song another one played this week, and every finished show is kept for a year.</p>
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("join")}>Join one</button>
        <button type="button" className="btn btn-teal" onClick={() => go("create")}>Make a group</button>
      </div>
    </section>
  );

  if (view === "invite") return <InviteView invite={group.invite} name={group.name} onDone={() => go("summary")} />;

  if (view === "leave") return (
    <section className={s.panel} aria-label="Leave group">
      <span className={s.eyebrow}>Leave {group.name}?</span>
      <p className={s.text}>This phone goes back to its own song history. The group keeps its past shows for the other phones.</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("summary")}>Stay</button>
        <button type="button" className="btn btn-primary" onClick={() => { void unlinkGroup(group.id); leaveGroup(); go("summary"); }}>Leave</button>
      </div>
      {group.owner && <button type="button" className={`link ${s.linkBtn}`} onClick={() => go("delete")}>Delete the group for every phone</button>}
    </section>
  );

  if (view === "delete") return (
    <section className={s.panel} aria-label="Delete group">
      <span className={s.eyebrow}>Delete {group.name}?</span>
      <p className={s.text}>Every phone loses the group's past shows and shared song history. This can't be undone.</p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={() => go("summary")} disabled={busy}>Keep it</button>
        <button type="button" className="btn btn-primary" onClick={() => run(deleteGroup, "summary")} disabled={busy}>Delete</button>
      </div>
    </section>
  );

  const status = sync === "revoked" ? "Invite no longer works"
    : sync === "syncing" ? "Syncing"
    : pending ? `${pending} waiting to sync`
    : sync === "offline" ? "Offline"
    : "In sync";
  return (
    <section className={s.panel} aria-label="Group">
      <div className={s.top}>
        <span className={s.eyebrow}>Your group</span>
        <span className={`${s.status} ${sync === "revoked" ? s.bad : pending || sync === "offline" ? s.wait : ""}`}>{status}</span>
      </div>
      <p className={s.name}>{group.name}</p>
      {sync === "revoked" ? (
        <>
          <p className={s.text}>This group was deleted, or its invite changed. Leave it to keep playing with this phone's own history.</p>
          <button type="button" className="btn btn-primary" onClick={() => { leaveGroup(); go("summary"); }}>Leave the group</button>
        </>
      ) : (
        <>
          <div className={s.row}>
            <button type="button" className="btn btn-cream" onClick={showPastGames}>Past shows</button>
            <button type="button" className="btn btn-teal" onClick={() => go("invite")}>Invite</button>
          </div>
          <button type="button" className={`link ${s.linkBtn}`} onClick={() => go("leave")}>Leave this group</button>
        </>
      )}
    </section>
  );
}

function HistoryCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }){
  const count = useMemo(localHistoryCount, []);
  if (!count) return null;
  return (
    <label className={s.check}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span>Bring this phone's recent songs ({count}) so the group skips them too</span>
    </label>
  );
}

function CreateForm({ busy, error, onCancel, onCreate }: {
  busy: boolean; error: string; onCancel: () => void; onCreate: (name: string, withHistory: boolean) => void;
}){
  const [name, setName] = useState("");
  const [withHistory, setWithHistory] = useState(true);
  const clean = name.trim();
  return (
    <form className={s.panel} aria-label="Make a group" onSubmit={e => { e.preventDefault(); if (clean && !busy) onCreate(clean, withHistory); }}>
      <span className={s.eyebrow}>Make a group</span>
      <label className={s.field}>
        <span className={s.fieldLabel}>Group name</span>
        <input className={s.input} value={name} maxLength={GROUP_NAME_MAX} placeholder="Friday night crew" autoFocus
          onChange={e => setName(e.target.value)} />
      </label>
      <HistoryCheck checked={withHistory} onChange={setWithHistory} />
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-teal" disabled={busy || !clean}>{busy ? "Making" : "Make it"}</button>
      </div>
    </form>
  );
}

function JoinForm({ invite: given, current, currentId, busy, error, onCancel, onJoin }: {
  invite: string; current: string; currentId: string; busy: boolean; error: string;
  onCancel: () => void; onJoin: (invite: string, withHistory: boolean) => void;
}){
  const broken = given === BROKEN_INVITE;
  const invite = broken ? "" : given;
  const [code, setCode] = useState("");
  const [withHistory, setWithHistory] = useState(true);
  const [preview, setPreview] = useState<{ name?: string; error?: string }>({});
  useEffect(() => {
    if (!invite) return;
    let live = true;
    previewInvite(invite).then(name => live && setPreview({ name }), e => live && setPreview({ error: message(e) }));
    return () => { live = false; };
  }, [invite]);

  const token = invite || parseInvite(code);
  const same = !!token && token.split(".")[0] === currentId;
  const typedBad = !invite && code.trim().length > 0 && !token;
  const shownError = error || preview.error
    || (typedBad ? "That doesn't look like an invite. Paste the whole link or code."
      : broken && !code.trim() ? "That invite link is incomplete. Ask for it again, or paste the whole link or code here." : "");
  return (
    <form className={s.panel} aria-label="Join a group" onSubmit={e => { e.preventDefault(); if (token && !busy && !same) onJoin(token, withHistory); }}>
      <span className={s.eyebrow}>{invite ? "You're invited" : "Join a group"}</span>
      {invite ? (
        <p className={s.text}>
          {preview.name ? <>Join <b className={s.inline}>{preview.name}</b>? This phone will skip songs the group played lately, and your finished shows land in its past shows.</>
            : preview.error ? "This invite can't be used." : "Checking the invite…"}
        </p>
      ) : (
        <label className={s.field}>
          <span className={s.fieldLabel}>Invite link or code</span>
          <input className={s.input} value={code} placeholder="Paste it here" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={e => setCode(e.target.value)} />
        </label>
      )}
      {same ? <p className={s.note}>This phone is already in {current}.</p>
        : current && token ? <p className={s.note}>This phone leaves {current}.</p> : null}
      {!same && <HistoryCheck checked={withHistory} onChange={setWithHistory} />}
      {shownError && <p className={s.error} role="alert">{shownError}</p>}
      <div className={s.row}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>{given ? "Not now" : "Cancel"}</button>
        <button type="submit" className="btn btn-teal" disabled={busy || !token || same || (!!invite && !preview.name)}>{busy ? "Joining" : "Join"}</button>
      </div>
    </form>
  );
}

function InviteView({ invite, name, onDone }: { invite: string; name: string; onDone: () => void }){
  const link = inviteLink(invite);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === "function";
  async function copy(){
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      (document.getElementById("tt-invite-link") as HTMLInputElement | null)?.select();
    }
  }
  return (
    <section className={s.panel} aria-label="Invite a phone">
      <span className={s.eyebrow}>Invite a phone to {name}</span>
      <div className={s.inviteBody}>
        <Qr text={link} className={s.qr} label="Invite QR code" />
        <p className={s.text}>Scan it with the other phone's camera, or send the link. Anyone with it joins the group and sees its past shows.</p>
      </div>
      <input id="tt-invite-link" className={`${s.input} ${s.code}`} value={link} readOnly aria-label="Invite link" onFocus={e => e.target.select()} />
      <div className={s.row}>
        <button type="button" className="btn btn-cream" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        {canShare
          ? <button type="button" className="btn btn-teal" onClick={() => navigator.share({ title: "Tune Teasers", text: `Join ${name} on Tune Teasers`, url: link }).catch(() => {})}>Share</button>
          : <button type="button" className="btn btn-teal" onClick={onDone}>Done</button>}
      </div>
      {canShare && <button type="button" className={`link ${s.linkBtn}`} onClick={onDone}>Done</button>}
    </section>
  );
}
