import { useCallback, useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
  return body as T;
}
export const post = (p: string, b: unknown) => api(p, { method: 'POST', body: JSON.stringify(b) });
export const patch = (p: string, b: unknown) => api(p, { method: 'PATCH', body: JSON.stringify(b) });
export const put = (p: string, b: unknown) => api(p, { method: 'PUT', body: JSON.stringify(b) });
export const del = (p: string) => api(p, { method: 'DELETE' });

/** Poll an endpoint. Keeps last good data on error and reports the error separately (never swaps in fake data). */
export function usePoll<T = any>(path: string | null, ms = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState<number | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const load = useCallback(async () => {
    if (!pathRef.current) return;
    const p = pathRef.current;
    try {
      const d = await api<T>(p);
      if (pathRef.current === p) { setData(d); setError(null); setAt(Date.now()); }
    } catch (e: any) { if (pathRef.current === p) setError(e.message || 'Network error'); }
    finally { if (pathRef.current === p) setLoading(false); }
  }, []);
  useEffect(() => {
    setLoading(true);
    load();
    if (!ms) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, ms);
    return () => clearInterval(id);
  }, [path, ms, load]);
  return { data, error, loading, reload: load, at };
}

export function useHashRoute() {
  const [h, setH] = useState(() => location.hash.slice(1) || '/overview');
  useEffect(() => { const f = () => setH(location.hash.slice(1) || '/overview'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h;
}
export const go = (p: string) => { location.hash = p; };

// ---------- formatting: null/undefined => "Unavailable", never 0 ----------
export const isNum = (v: any): v is number => typeof v === 'number' && Number.isFinite(v);
export function usd(v: any, opts: { compact?: boolean; sign?: boolean; dp?: number } = {}) {
  if (!isNum(v)) return null;
  const sign = opts.sign && v > 0 ? '+' : '';
  const a = Math.abs(v);
  if (opts.compact !== false && a >= 1e6) return `${sign}${v < 0 ? '−' : ''}$${(a / 1e6).toFixed(2)}M`;
  if (opts.compact !== false && a >= 1e4) return `${sign}${v < 0 ? '−' : ''}$${(a / 1e3).toFixed(1)}k`;
  return `${sign}${v < 0 ? '−' : ''}$${a.toLocaleString(undefined, { minimumFractionDigits: opts.dp ?? (a < 100 ? 2 : 0), maximumFractionDigits: opts.dp ?? (a < 100 ? 2 : 0) })}`;
}
export const pct = (v: any, dp = 0, sign = false) => (isNum(v) ? `${sign && v > 0 ? '+' : ''}${(v * 100).toFixed(dp)}%` : null);
export const cents = (v: any) => (isNum(v) ? `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0)}¢` : null);
export const centsDelta = (v: any) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(1)}¢` : null);
export const num = (v: any, dp = 0) => (isNum(v) ? v.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp }) : null);
export function ago(ts: any) {
  if (!isNum(ts) || ts <= 0) return null;
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h ago`;
  return `${(s / 86400).toFixed(s < 864000 ? 1 : 0)}d ago`;
}
export const dur = (s: any) => (!isNum(s) ? null : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(0)}d`);
export const dt = (ts: any) => (isNum(ts) ? new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);
export const shortAddr = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const signCls = (v: any) => (isNum(v) ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '');
