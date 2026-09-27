import { useEffect, useState } from "react";
import { engine } from "../lib/engine.js";
import { sanitizeTrack } from "../lib/storage.js";
import type { Track } from "../types";

type Stage = "low" | "cancel" | "full";
const stages: { id: Stage; name: string; detail: string }[] = [
  { id: "low", name: "1. Bass + drums", detail: "Low frequencies and softened highs. Vocals can still bleed through." },
  { id: "cancel", name: "2. Centre removed", detail: "Subtracts right from left. Centre vocals often fade, but centred bass and drums fade too." },
  { id: "full", name: "3. Full mix", detail: "Original preview with no filter." },
];

export function AudioPrototype(){
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState(0);
  const [stage, setStage] = useState<Stage>("low");
  const [status, setStatus] = useState("Loading the song catalog...");
  const [playing, setPlaying] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(()=>{
    let active = true;
    fetch("./catalog.json").then(r=>{ if (!r.ok) throw Error(); return r.json(); })
      .then(data=>{
        const valid: Track[] = (Array.isArray(data.tracks) ? data.tracks : [])
          .map(sanitizeTrack).filter((track: Track | null): track is Track => !!track);
        const found = [
          ...valid.filter(track=>track.lang === "bolly").slice(0, 15),
          ...valid.filter(track=>track.lang === "telugu").slice(0, 15),
        ];
        if (active){ setTracks(found); setStatus(found.length ? "Choose a song and press Play." : "No songs in the catalog."); }
      }).catch(()=>{ if (active) setStatus("Could not load the song catalog."); });
    return ()=>{ active = false; engine.stop(); };
  }, []);

  async function play(){
    const track = tracks[selected];
    if (!track) return;
    setStatus("Cueing the preview...");
    setPlaying(false);
    setLatency(null);
    const started = performance.now();
    const result = await engine.playPrototype(track, stage, ()=>{
      setPlaying(false);
      setLatency(null);
      setStatus("Preview ended. Press Play to hear it again.");
    });
    if (result === "superseded") return;
    if (result === "playing"){
      setLatency(Math.round(performance.now() - started));
      setStatus("Playing a 30-second preview. Switch stages while it plays.");
      setPlaying(true);
    } else setStatus(result === "stream-failed"
      ? "This preview did not load. Try another song."
      : "Web Audio could not play this preview. Check browser support and CORS.");
  }

  function selectStage(next: Stage){
    setStage(next);
    if (playing && !engine.setPrototypeStage(next)){
      setPlaying(false);
      setStatus("Audio stopped. Press Play to restart.");
    }
  }

  function stop(){
    engine.stop();
    setPlaying(false);
    setLatency(null);
    setStatus("Stopped. Press Play to hear the selected song.");
  }

  return <main className="wrap prototype">
    <a href="./" className="prototype-back">← TuneTeasers</a>
    <p className="eyebrow">AUDIO EXPERIMENT</p>
    <h1>Hear the hint ladder</h1>
    <p className="sub">Compare three live treatments of the same song preview. This experiment does not affect a game.</p>
    <section className="card">
      <label className="label" htmlFor="prototype-song">SONG PREVIEW</label>
      <select id="prototype-song" value={selected} onChange={e=>{ stop(); setSelected(Number(e.target.value)); }} disabled={!tracks.length}>
        {tracks.map((track, i)=><option key={track.stream} value={i}>{track.lang === "telugu" ? "Telugu" : "Hindi"} · {track.title} - {track.artist}</option>)}
      </select>
      <p className="prototype-source">Existing TuneTeasers catalog preview. Processing happens on your device.</p>
    </section>
    <section className="card">
      <p className="label">STAGE</p>
      <div className="prototype-stages">
        {stages.map(item=><button key={item.id} type="button" aria-pressed={stage===item.id}
          className={`prototype-stage ${stage===item.id ? "selected" : ""}`} onClick={()=>selectStage(item.id)}>
          <strong>{item.name}</strong><span>{item.detail}</span>
        </button>)}
      </div>
    </section>
    <div className="row2">
      <button type="button" className="btn btn-gold" disabled={!tracks.length} onClick={play}>{playing ? "Restart" : "Play"}</button>
      <button type="button" className="btn btn-dark" disabled={!playing} onClick={stop}>Stop</button>
    </div>
    <p role="status" className="prototype-status">{status}{latency !== null ? ` Start: ${latency} ms.` : ""}</p>
    <p className="footnote">Centre cancellation needs stereo separation and cannot reliably remove vocals. Mono or centre-heavy recordings may sound thin or nearly silent. Streaming requires CORS and a browser with Web Audio. iPhone Safari requires a tap to start playback.</p>
  </main>;
}
