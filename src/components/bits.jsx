export const Chip = ({ on, tone, onClick, children }) => (
  <button class={`chip ${on ? "on-"+(tone||"gold") : ""}`} onClick={onClick}>{children}</button>
);

export const Disc = ({ spinning, art }) => (
  <div class="disc-wrap">
    <div class={`disc ${spinning ? "spinning" : ""}`} style={art ? `background-image:url('${art}')` : ""}>
      {!art && <div class="disc-hole">?</div>}
    </div>
  </div>
);

export const ScoreRow = ({ left, right, style }) => (
  <div class="boardrow" style={style}>
    <span>{left}</span><span>{right}</span>
  </div>
);
