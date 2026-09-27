export const Reel = ({ size = 96, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden>
    <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" strokeWidth="5" />
    <circle cx="50" cy="50" r="9" fill="currentColor" />
    {[0, 60, 120, 180, 240, 300].map(a => (
      <g key={a} transform={`rotate(${a} 50 50)`}>
        <path d="M50 14 a36 36 0 0 1 31 18 L64 42 A16 16 0 0 0 50 34 Z" fill="currentColor" opacity="0.18" />
        <line x1="50" y1="12" x2="50" y2="36" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      </g>
    ))}
  </svg>
);
