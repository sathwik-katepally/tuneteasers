import { useEffect, useState } from "react";

// The encoder loads only when a code is shown, keeping it out of the game bundle.
export function Qr({ text, className, label }: { text: string; className?: string; label: string }){
  const [qr, setQr] = useState<{ size: number; d: string } | null>(null);
  useEffect(() => {
    let live = true;
    import("uqr").then(({ encode }) => {
      const { size, data } = encode(text, { ecc: "M", border: 2 });
      let d = "";
      data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
      if (live) setQr({ size, d });
    }, () => {});
    return () => { live = false; };
  }, [text]);
  if (!qr) return <div className={className} aria-hidden />;
  return (
    <svg className={className} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label={label}>
      <rect width={qr.size} height={qr.size} fill="#fff8e8" />
      <path d={qr.d} fill="#1c0b08" />
    </svg>
  );
}
