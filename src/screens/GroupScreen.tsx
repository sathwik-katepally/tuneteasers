import { GroupPanel } from "../components/GroupPanel";
import sh from "./shared.module.css";

/* Cross-phone sync, reached from the home menu or an invite link; never offered unasked. */
export function GroupScreen({ invite, clearInvite, showPastGames, onBack }: {
  invite: string; clearInvite: () => void; showPastGames: () => void; onBack: () => void;
}){
  return (
    <div className={sh.stage}>
      <GroupPanel invite={invite} clearInvite={clearInvite} showPastGames={showPastGames} />
      <div className={sh.actions}>
        <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
