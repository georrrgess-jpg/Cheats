import React, { useMemo, useRef, useState } from 'react';
import { ago, isNum, shortAddr, go } from './lib';

export function U({ v, why, children }: { v: React.ReactNode; why?: string; children?: React.ReactNode }) {
  if (v === null || v === undefined || v === '') return <span className="unavail" title={why || 'Not available from the data source.'}>Unavailable</span>;
  return <>{children ?? v}</>;
}

export const Icon = {
  overview: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>,
  wallets: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5c2.4.2 4 1.8 4.6 4.5"/></svg>,
  activity: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>,
  consensus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="8.5" cy="10" r="5.5"/><circle cx="15.5" cy="10" r="5.5"/><circle cx="12" cy="16" r="5.5"/></svg>,
  paper: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 19V5M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>,
  bell: <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>,
  ext: <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>,
};

const STATE_CLS: Record<string, string> = { 'New agreement': 'b-accent', Building: 'b-good', Weakening: 'b-warn', Stale: 'b-crit', Stable: '', Ended: '' };
const STATE_ICON: Record<string, string> = { 'New agreement': '✦', Building: '▲', Weakening: '▼', Stale: '⚠', Stable: '■', Ended: '○' };
export function StateBadge({ state, title }: { state?: string | null; title?: string }) {
  if (!state) return <span className="badge" title="Not yet persisted as a signal (below minimum support or not computed yet)">—</span>;
  return <span className={`badge ${STATE_CLS[state] ?? ''}`} title={title}>{STATE_ICON[state]} {state}</span>;
}
export function GradeBadge({ grade, issues }: { grade: string; issues?: string[] }) {
  const cls = grade === 'High' ? 'b-good' : grade === 'Medium' ? 'b-warn' : 'b-crit';
  return <span className={`badge ${cls}`} title={issues?.length ? issues.join('\n') : 'No data issues detected'}>Data: {grade}</span>;
}

export function ScoreBar({ value, max = 100, color = 'var(--accent)' }: { value: number | null; max?: number; color?: string }) {
  if (!isNum(value)) return <U v={null} />;
  return (
    <div className="score">
      <span className="score-num">{Math.round(value)}</span>
      <div className="bar"><span style={{ width: `${Math.max(2, (value / max) * 100)}%`, background: color }} /></div>
    </div>
  );
}

export function Comp({ label, v, w, detail }: { label: string; v: number | null; w?: number; detail?: string }) {
  return (
    <div className="comp-row" title={detail}>
      <span className="muted">{label}{w !== undefined && <span className="faint"> ×{w}</span>}</span>
      <div className="bar"><span style={{ width: `${isNum(v) ? Math.max(1, v * 100) : 0}%`, background: 'var(--accent)' }} /></div>
      <span className="num r" style={{ textAlign: 'right' }}>{isNum(v) ? v.toFixed(2) : <U v={null} why={detail} />}</span>
    </div>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return <div className="stack card-pad">{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />)}</div>;
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty fade-in"><h2>{title}</h2><div className="small">{children}</div></div>;
}
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <div className="banner err" style={{ borderRadius: 8, margin: 12 }}>⚠ {error} {onRetry && <button className="sm" onClick={onRetry}>Retry</button>}</div>;
}

export function Wallet({ address, label, link = true }: { address: string; label?: string | null; link?: boolean }) {
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  const inner = <span className="wallet-chip"><span className="avatar" style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 55%), hsl(${(hue + 60) % 360} 55% 45%))` }} />{label || <span className="mono">{shortAddr(address)}</span>}</span>;
  return link ? <a href={`#/wallets/${address}`} onClick={(e) => e.stopPropagation()} title={address}>{inner}</a> : inner;
}

export function Ext({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{children} {Icon.ext}</a>;
}

export function Fresh({ ts, staleAfter }: { ts: number | null | undefined; staleAfter?: number }) {
  if (!isNum(ts)) return <span className="badge b-crit">never synced</span>;
  const age = Date.now() / 1000 - ts;
  const stale = staleAfter !== undefined && age > staleAfter;
  return <span className={`badge ${stale ? 'b-warn' : ''}`} title={new Date(ts * 1000).toLocaleString()}>{stale ? '⚠ ' : ''}{ago(ts)}</span>;
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="card card-pad stat"><div className="label">{label}</div><div className="value">{value}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

/** Single-series line chart with crosshair tooltip. Optional reference lines (e.g. entry price, first-observed price). */
export function LineChart({ points, height = 200, format, refs = [], yDomain, label }: {
  points: { ts: number; v: number }[]; height?: number; format: (v: number) => string; refs?: { v: number; label: string; dash?: boolean }[];
  yDomain?: [number, number]; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, P = { l: 48, r: 12, t: 10, b: 22 };
  const g = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.ts), ys = points.map((p) => p.v).concat(refs.map((r) => r.v));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = yDomain ? yDomain[0] : Math.min(...ys), y1 = yDomain ? yDomain[1] : Math.max(...ys);
    if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
    const pad = yDomain ? 0 : (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
    const sx = (t: number) => P.l + ((t - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
    const sy = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.ts).toFixed(1)},${sy(p.v).toFixed(1)}`).join('');
    const ticks = [0, 0.5, 1].map((f) => y0 + (y1 - y0) * f);
    return { sx, sy, d, ticks, x0, x1 };
  }, [points, refs, yDomain, H]);
  if (!g) return <Empty title="Not enough history">At least two data points are needed to draw this chart.</Empty>;
  const hp = hover !== null ? points[hover] : null;
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const t = g.x0 + ((((e.clientX - r.left) / r.width) * W - P.l) / (W - P.l - P.r)) * (g.x1 - g.x0);
    let best = 0; for (let i = 0; i < points.length; i++) if (Math.abs(points[i].ts - t) < Math.abs(points[best].ts - t)) best = i;
    setHover(best);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: 'block' }}>
        {g.ticks.map((t, i) => (
          <g key={i}><line x1={P.l} x2={W - P.r} y1={g.sy(t)} y2={g.sy(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={P.l - 6} y={g.sy(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-3)">{format(t)}</text></g>
        ))}
        <text x={P.l} y={H - 4} fontSize="10.5" fill="var(--text-3)">{new Date(g.x0 * 1000).toLocaleDateString()}</text>
        <text x={W - P.r} y={H - 4} textAnchor="end" fontSize="10.5" fill="var(--text-3)">{new Date(g.x1 * 1000).toLocaleDateString()}</text>
        {refs.map((r, i) => (
          <g key={i}><line x1={P.l} x2={W - P.r} y1={g.sy(r.v)} y2={g.sy(r.v)} stroke="var(--text-2)" strokeWidth="1" strokeDasharray={r.dash === false ? undefined : '4 4'} />
            <text x={W - P.r - 2} y={g.sy(r.v) - 4} textAnchor="end" fontSize="10.5" fill="var(--text-2)">{r.label} {format(r.v)}</text></g>
        ))}
        <path d={g.d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {hp && <g><line x1={g.sx(hp.ts)} x2={g.sx(hp.ts)} y1={P.t} y2={H - P.b} stroke="var(--border-strong)" />
          <circle cx={g.sx(hp.ts)} cy={g.sy(hp.v)} r="4" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" /></g>}
      </svg>
      {hp && <div className="chart-tip" style={{ left: `min(calc(${(g.sx(hp.ts) / W) * 100}% + 10px), calc(100% - 150px))`, top: 4 }}>
        <div className="faint">{new Date(hp.ts * 1000).toLocaleString()}</div><b className="num">{format(hp.v)}</b></div>}
    </div>
  );
}

export function Section({ title, right, children, pad = true }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; pad?: boolean }) {
  return <div className="card fade-in"><div className="card-head"><h2>{title}</h2>{right}</div>{pad ? <div className="card-pad">{children}</div> : children}</div>;
}

export const goMarket = (cid: string, token?: string) => go(`/market/${cid}${token ? `?t=${token}` : ''}`);
