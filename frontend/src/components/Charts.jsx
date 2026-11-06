const LEVEL_COLOR = { low: '#16a34a', medium: '#d97706', high: '#ea580c', critical: '#dc2626' };
export const levelColor = (l) => LEVEL_COLOR[l] || '#6366f1';

/** Semicircle gauge for a 0–100 risk score. */
export function RiskGauge({ score, level, size = 180 }) {
  const r = 70; const c = Math.PI * r; const pct = Math.min(100, Math.max(0, score)) / 100;
  return (
    <div className="gauge" role="img" aria-label={`Risk score ${score} out of 100, ${level}`}>
      <svg width={size} height={size / 2 + 12} viewBox="0 0 180 100">
        <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke="var(--border)" strokeWidth="14" strokeLinecap="round" />
        <path d="M 20 90 A 70 70 0 0 1 160 90" fill="none" stroke={levelColor(level)} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} style={{ transition: 'stroke-dasharray .6s' }} />
      </svg>
      <div className="num" style={{ color: levelColor(level) }}>{score}</div>
    </div>
  );
}

/** Minimal sparkline. `values` may contain nulls. */
export function Sparkline({ values, color = '#6366f1', width = 170, height = 44, max }) {
  const pts = values.map((v, i) => (v == null ? null : [i, v])).filter(Boolean);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const hi = max ?? Math.max(...pts.map((p) => p[1]), 1);
  const x = (i) => (i / Math.max(1, values.length - 1)) * (width - 4) + 2;
  const y = (v) => height - 4 - (v / hi) * (height - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r="3" fill={color} />
    </svg>
  );
}
