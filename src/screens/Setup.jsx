import { ERAS } from "../lib/constants.js";
import { Chip, Disc } from "../components/bits.jsx";

export function Loading(){
  return (
    <div class="wrap center" key="loading" style="padding-top:20vh">
      <Disc spinning={true} />
      <div class="display" style="font-size:22px;font-weight:700;margin-top:12px">Digging through the crates…</div>
      <div class="sub" style="margin-top:6px">Loading songs</div>
    </div>
  );
}

export function Setup({ error, S, upSettings, toggleEra, players, renamePlayer, removePlayer, addPlayer, blocked, unblockArtist, startGame, savedGame, resumeGame, discardGame }){
  return (
    <div class="wrap" key="setup">
      <div class="center" style="margin:24px 0 28px">
        <div class="eyebrow">PASS-THE-PHONE PARTY GAME</div>
        <h1>Tune<span style="color:var(--rose)">Teasers</span></h1>
        <p class="sub">Hear the melody. Shout the song. Claim the point.</p>
      </div>
      {error && <div class="card" style="border:1.5px solid var(--rose)"><div class="sub">{error}</div></div>}
      {savedGame && (
        <div class="card" style="border:1.5px solid var(--marigold)">
          <div class="label">GAME IN PROGRESS</div>
          <div class="sub" style="margin-bottom:12px">
            Round {savedGame.round} · {players[savedGame.turn]?.name} is up · song {Math.min(savedGame.trackIdx+1, savedGame.totalSongs)} of {savedGame.totalSongs}
          </div>
          <button class="btn btn-gold" onClick={resumeGame}>▶ Resume game</button>
          <div class="gap"></div>
          <button class="btn btn-ghost" style="padding:10px" onClick={discardGame}>Discard it</button>
        </div>
      )}
      <div class="card">
        <div class="label">MUSIC MIX · songs from 2000 onwards</div>
        <div class="chips">
          <Chip on={S.mix==="bolly"} tone="rose" onClick={()=>upSettings({mix:"bolly"})}>Bollywood</Chip>
          <Chip on={S.mix==="telugu"} tone="teal" onClick={()=>upSettings({mix:"telugu"})}>Telugu</Chip>
          <Chip on={S.mix==="both"} onClick={()=>upSettings({mix:"both"})}>Both</Chip>
        </div>
      </div>
      <div class="card">
        <div class="label">ERA · pick one or more</div>
        <div class="chips">
          {ERAS.map(e => <Chip key={e} on={S.eras.includes(e)} onClick={()=>toggleEra(e)}>{e}</Chip>)}
        </div>
      </div>
      <div class="card">
        <div class="label">SOUND</div>
        <div class="chips">
          <Chip on={S.sound==="inst"} onClick={()=>upSettings({sound:"inst"})}>🎻 Music only</Chip>
          <Chip on={S.sound==="full"} onClick={()=>upSettings({sound:"full"})}>🎤 With vocals</Chip>
        </div>
        {S.sound==="inst" && <div class="sub" style="font-size:12px;margin-top:8px">Snippets play each song's most instrumental stretch.</div>}
      </div>
      <div class="card">
        <div class="label">SNIPPET LENGTH</div>
        <div class="chips">
          {[5,10,15].map(s => <Chip key={s} on={S.snippetLen===s} onClick={()=>upSettings({snippetLen:s})}>{s}s</Chip>)}
        </div>
      </div>
      <div class="card">
        <div class="label">PLAYERS</div>
        {players.map((p,i)=>(
          <div class="prow" key={i}>
            <input type="text" value={p.name} onInput={e=>renamePlayer(i, e.target.value)} />
            {players.length>1 && <button class="xbtn" aria-label="Remove player" onClick={()=>removePlayer(i)}>✕</button>}
          </div>
        ))}
        {players.length<8 && <button class="btn btn-ghost" style="padding:10px" onClick={addPlayer}>+ Add player</button>}
      </div>
      {blocked.length>0 && (
        <div class="card">
          <div class="label">BLOCKED ARTISTS · tap to bring one back</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            {blocked.map(a => <button class="chip" style="flex:0 0 auto" key={a} onClick={()=>unblockArtist(a)}>✕ {a}</button>)}
          </div>
        </div>
      )}
      <button class="btn btn-gold pulse" style="font-size:19px" onClick={startGame}>Start the game</button>
    </div>
  );
}
