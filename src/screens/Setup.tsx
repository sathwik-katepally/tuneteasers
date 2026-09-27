import { ERAS } from "../lib/constants.js";
import { Chip, Disc } from "../components/bits";
import type { GameState, Player, Settings } from "../types";

interface SetupProps {
  error: string;
  S: Settings;
  upSettings: (patch: Partial<Settings>) => void;
  toggleEra: (era: string) => void;
  players: Player[];
  renamePlayer: (index: number, name: string) => void;
  removePlayer: (index: number) => void;
  addPlayer: () => void;
  blocked: string[];
  unblockArtist: (name: string) => void;
  startGame: () => void;
  savedGame: GameState | null;
  resumeGame: () => void;
  discardGame: () => void;
}

export function Loading(){
  return (
    <div className="wrap center" key="loading" style={{ paddingTop: "20vh" }}>
      <Disc spinning={true} />
      <div className="display" style={{ fontSize: "22px", fontWeight: "700", marginTop: "12px" }}>Digging through the crates…</div>
      <div className="sub" style={{ marginTop: "6px" }}>Loading songs</div>
    </div>
  );
}

export function Setup({ error, S, upSettings, toggleEra, players, renamePlayer, removePlayer, addPlayer, blocked, unblockArtist, startGame, savedGame, resumeGame, discardGame }: SetupProps){
  return (
    <div className="wrap" key="setup">
      <div className="center" style={{ margin: "24px 0 28px" }}>
        <div className="eyebrow">PASS-THE-PHONE PARTY GAME</div>
        <h1>Tune<span style={{ color: "var(--rose)" }}>Teasers</span></h1>
        <p className="sub">Hear the melody. Shout the song. Claim the point.</p>
      </div>
      {error && <div className="card" style={{ border: "1.5px solid var(--rose)" }}><div className="sub">{error}</div></div>}
      {savedGame && (
        <div className="card" style={{ border: "1.5px solid var(--marigold)" }}>
          <div className="label">GAME IN PROGRESS</div>
          <div className="sub" style={{ marginBottom: "12px" }}>
            Round {savedGame.round} · {players[savedGame.turn]?.name} is up · song {Math.min(savedGame.trackIdx+1, savedGame.totalSongs)} of {savedGame.totalSongs}
          </div>
          <button className="btn btn-gold" onClick={resumeGame}>▶ Resume game</button>
          <div className="gap"></div>
          <button className="btn btn-ghost" style={{ padding: "10px" }} onClick={discardGame}>Discard it</button>
        </div>
      )}
      <div className="card">
        <div className="label">MUSIC MIX · songs from 2000 onwards</div>
        <div className="chips">
          <Chip on={S.mix==="bolly"} tone="rose" onClick={()=>upSettings({mix:"bolly"})}>Bollywood</Chip>
          <Chip on={S.mix==="telugu"} tone="teal" onClick={()=>upSettings({mix:"telugu"})}>Telugu</Chip>
          <Chip on={S.mix==="both"} onClick={()=>upSettings({mix:"both"})}>Both</Chip>
        </div>
      </div>
      <div className="card">
        <div className="label">ERA · pick one or more</div>
        <div className="chips">
          {ERAS.map(e => <Chip key={e} on={S.eras.includes(e)} onClick={()=>toggleEra(e)}>{e}</Chip>)}
        </div>
      </div>
      <div className="card">
        <div className="label">SOUND</div>
        <div className="chips">
          <Chip on={S.sound==="inst"} onClick={()=>upSettings({sound:"inst"})}>🎻 Music only</Chip>
          <Chip on={S.sound==="full"} onClick={()=>upSettings({sound:"full"})}>🎤 With vocals</Chip>
        </div>
        {S.sound==="inst" && <div className="sub" style={{ fontSize: "12px", marginTop: "8px" }}>Snippets play each song's most instrumental stretch.</div>}
      </div>
      <div className="card">
        <div className="label">SNIPPET LENGTH</div>
        <div className="chips">
          {[5,10,15].map(s => <Chip key={s} on={S.snippetLen===s} onClick={()=>upSettings({snippetLen:s})}>{s}s</Chip>)}
        </div>
      </div>
      <div className="card">
        <div className="label">PLAYERS</div>
        {players.map((p,i)=>(
          <div className="prow" key={i}>
            <input type="text" value={p.name} onInput={e=>renamePlayer(i, e.currentTarget.value)} />
            {players.length>1 && <button className="xbtn" aria-label="Remove player" onClick={()=>removePlayer(i)}>✕</button>}
          </div>
        ))}
        {players.length<8 && <button className="btn btn-ghost" style={{ padding: "10px" }} onClick={addPlayer}>+ Add player</button>}
      </div>
      {blocked.length>0 && (
        <div className="card">
          <div className="label">BLOCKED ARTISTS · tap to bring one back</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {blocked.map(a => <button className="chip" style={{ flex: "0 0 auto" }} key={a} onClick={()=>unblockArtist(a)}>✕ {a}</button>)}
          </div>
        </div>
      )}
      <button className="btn btn-gold pulse" style={{ fontSize: "19px" }} onClick={startGame}>Start the game</button>
    </div>
  );
}
