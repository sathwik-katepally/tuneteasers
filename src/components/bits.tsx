import type { CSSProperties, ReactNode } from "react";

export const Chip = ({ on, tone, onClick, children }: { on: boolean; tone?: string; onClick: () => void; children: ReactNode }) => (
  <button className={`chip ${on ? "on-"+(tone||"gold") : ""}`} onClick={onClick}>{children}</button>
);

export const Disc = ({ spinning, art }: { spinning: boolean; art?: string | null }) => (
  <div className="disc-wrap">
    <div className={`disc ${spinning ? "spinning" : ""}`} style={art ? { backgroundImage: `url('${art}')` } : undefined}>
      {!art && <div className="disc-hole">?</div>}
    </div>
  </div>
);

export const ScoreRow = ({ left, right, style }: { left: string; right: string; style?: CSSProperties }) => (
  <div className="boardrow" style={style}>
    <span>{left}</span><span>{right}</span>
  </div>
);
