import React, { useState } from 'react';
import { usePoll, post, del, patch, usd, pct, ago, dur, go, signCls, num } from '../lib';
import { U, Loading, ErrorBox, Empty, Wallet, ScoreBar, Fresh } from '../components';

const FLAG_TXT: Record<string, string> = {
  SMALL_SAMPLE: 'small sample', ONE_BIG_WIN: 'one big win', SHORT_HISTORY: 'short history', TRUNCATED_SAMPLE: 'sample capped', NEGATIVE_EDGE: 'negative edge',
  RECENT_LOSSES: 'recent losses', INACTIVE: 'inactive', POSSIBLE_MARKET_MAKER: 'possible MM', TWO_SIDED: 'two-sided',
};
const WARN = new Set(['SMALL_SAMPLE', 'ONE_BIG_WIN', 'SHORT_HISTORY', 'NEGATIVE_EDGE', 'INACTIVE']);
export function Flags({ flags }: { flags: string[] }) {
  if (!flags?.length) return <span className="tiny faint">none</span>;
  return <span className="row" style={{ gap: 4 }}>{flags.map((f) => <span key={f} className={`badge ${WARN.has(f) ? 'b-warn' : ''}`}>{FLAG_TXT[f] ?? f}</span>)}</span>;
}

function MetricsCells({ m }: { m: any }) {
  if (!m) return <><td colSpan={5} className="small faint">Evaluating… (queued; one wallet per worker cycle)</td></>;
  return <>
    <td><ScoreBar value={m.score} /></td>
    <td className="r num">{m.resolved}<div className="tiny faint">win <U v={pct(m.winRate)} /></div></td>
    <td className={`r num ${signCls(m.realized?.d30?.pnl)}`}><U v={usd(m.realized?.d30?.pnl, { sign: true })} why={m.realized?.d30?.note} /><div className="tiny faint">ROI <U v={pct(m.realized?.d30?.roi, 1)} why={m.realized?.d30?.note || 'No cost basis'} /></div></td>
    <td className="r num"><U v={usd(m.maxDrawdown)} why="Needs PnL history" /><div className="tiny faint">{m.historyDays ? `${Math.round(m.historyDays)}d history` : ''}</div></td>
    <td><Flags flags={m.flags} /></td>
  </>;
}

function AddWallet({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState(''), [l, setL] = useState(''), [c, setC] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="filters" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await post('/api/wallets', { address: a.trim(), label: l || null, cluster: c || null }); setA(''); setL(''); setC(''); onDone(); } catch (x: any) { setErr(x.message); } }}>
      <label className="field" style={{ flex: '2 1 320px' }}>Wallet address (Polymarket proxy wallet)<input value={a} onChange={(e) => setA(e.target.value)} placeholder="0x…" className="mono" required /></label>
      <label className="field" style={{ flex: '1 1 140px' }}>Label (optional)<input value={l} onChange={(e) => setL(e.target.value)} /></label>
      <label className="field" style={{ flex: '1 1 140px' }} title="Wallets with the same cluster name count as ONE supporter in consensus">Cluster (optional)<input value={c} onChange={(e) => setC(e.target.value)} placeholder="e.g. same-owner-A" /></label>
      <button className="primary" type="submit">Follow</button>
      {err && <span className="small neg" style={{ flexBasis: '100%' }}>{err}</span>}
    </form>
  );
}

function Watchlist() {
  const { data, error, loading, reload } = usePoll<any[]>('/api/wallets', 20000);
  const [edit, setEdit] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  return (
    <div className="card">
      <AddWallet onDone={reload} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data ? <Loading /> : !data?.length ? <Empty title="No wallets followed">Paste an address above, or use the Discover tab to evaluate leaderboard wallets. Aim for 10–50 wallets with credible histories.</Empty> :
        <div className="table-wrap"><table>
          <thead><tr><th>Wallet</th><th>Quality</th><th className="r">Resolved</th><th className="r" title="Our calculation from resolved/exited positions in the last 30 days">Realized 30d</th><th className="r">Max drawdown</th><th>Flags</th><th className="r">Open</th><th>Synced</th><th></th></tr></thead>
          <tbody>{data.map((w) => (
            <React.Fragment key={w.address}>
              <tr className="clickable" onClick={() => go(`/wallets/${w.address}`)}>
                <td><Wallet address={w.address} label={w.label} link={false} />{w.cluster && <div className="tiny"><span className="badge b-violet">cluster: {w.cluster}</span></div>}</td>
                <MetricsCells m={w.metrics} />
                <td className="r num">{w.open_positions}<div className="tiny faint">{usd(w.open_value)}</div></td>
                <td className="small"><Fresh ts={w.positions_synced_at} staleAfter={900} />{!w.backfill_done && w.activity_synced_at && <div className="tiny faint">backfilling…</div>}{(w.positions_error || w.activity_error) && <div className="tiny neg" title={w.positions_error || w.activity_error}>sync error</div>}</td>
                <td className="r" onClick={(e) => e.stopPropagation()}>
                  <button className="sm ghost" onClick={() => { setEdit(edit === w.address ? null : w.address); setForm({ label: w.label ?? '', cluster: w.cluster ?? '', notes: w.notes ?? '' }); }}>Edit</button>
                  <button className="sm ghost danger" onClick={async () => { if (confirm('Stop following this wallet? Its history stays stored.')) { await del(`/api/wallets/${w.address}`); reload(); } }}>Remove</button>
                </td>
              </tr>
              {edit === w.address && <tr><td colSpan={9} style={{ background: 'var(--bg)' }}>
                <div className="row">
                  <label className="field">Label<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
                  <label className="field">Cluster<input value={form.cluster} onChange={(e) => setForm({ ...form, cluster: e.target.value })} /></label>
                  <label className="field" style={{ flex: 1 }}>Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
                  <button className="primary sm" onClick={async () => { await patch(`/api/wallets/${w.address}`, form); setEdit(null); reload(); }}>Save</button>
                </div></td></tr>}
            </React.Fragment>))}</tbody>
        </table></div>}
    </div>
  );
}

function Discover() {
  const { data, error, loading, reload } = usePoll<any>('/api/discovery', 4000);
  const [sort, setSort] = useState<'score' | 'boards'>('score');
  const [hideFlagged, setHideFlagged] = useState(false);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const st = data.state;
  let rows = [...data.candidates];
  if (hideFlagged) rows = rows.filter((c) => c.metrics && !c.metrics.flags.some((f: string) => WARN.has(f)));
  rows.sort((a, b) => sort === 'score' ? (b.metrics?.score ?? -1) - (a.metrics?.score ?? -1) : b.boards.length - a.boards.length);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card card-pad">
        <div className="spread">
          <div><h2>Candidate universe</h2><div className="small muted" style={{ maxWidth: 820, marginTop: 4 }}>{data.coverage}</div></div>
          <button className="primary" disabled={st.running} onClick={async () => { await post('/api/discovery/run', {}); reload(); }}>{st.running ? `${st.phase} ${st.done}/${st.total}` : 'Run discovery'}</button>
        </div>
        {st.running && <div className="bar" style={{ marginTop: 12, height: 4 }}><span style={{ width: `${(st.done / Math.max(1, st.total)) * 100}%`, background: 'var(--accent)', transition: 'width .4s' }} /></div>}
        {st.error && <div className="small neg" style={{ marginTop: 8 }}>{st.error}</div>}
        {data.lastRun && <div className="tiny faint" style={{ marginTop: 8 }}>Last run {ago(data.lastRun.started_at)} · {data.lastRun.candidates ?? '—'} candidates · {data.lastRun.evaluated ?? '—'} evaluated</div>}
        <div className="note" style={{ marginTop: 12 }}>Leaderboard PnL is provider-reported. Week/month boards measure marked equity change (includes unrealized moves); the all-time board is realized only. Volume is in shares and is never treated as profit. Quality scores below are our own calculations from each wallet's position history.</div>
      </div>
      <div className="card">
        <div className="filters">
          <div className="seg"><button className={sort === 'score' ? 'on' : ''} onClick={() => setSort('score')}>By quality</button><button className={sort === 'boards' ? 'on' : ''} onClick={() => setSort('boards')}>By board presence</button></div>
          <label className="row small"><input type="checkbox" checked={hideFlagged} onChange={(e) => setHideFlagged(e.target.checked)} /> Hide wallets with warning flags</label>
        </div>
        {!rows.length ? <Empty title="No candidates yet">Press “Run discovery”. It reads public leaderboards and evaluates the top candidates (a few minutes, rate-limited).</Empty> :
          <div className="table-wrap"><table>
            <thead><tr><th>Wallet</th><th>Boards (rank · provider PnL)</th><th>Quality</th><th className="r">Resolved</th><th className="r" title="Our calculation from resolved/exited positions in the last 30 days">Realized 30d</th><th className="r">Max drawdown</th><th>Flags</th><th></th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.address} className="clickable" onClick={() => go(`/wallets/${c.address}`)}>
                <td><Wallet address={c.address} label={c.userName} link={false} /></td>
                <td className="small">{c.boards.map((b: any) => <div key={b.period + b.category}><span className="faint">{b.period}</span> #{b.rank} · {usd(b.pnl)}</div>)}</td>
                {c.metrics ? <MetricsCells m={c.metrics} /> : <td colSpan={5} className="small faint" onClick={(e) => e.stopPropagation()}>Not evaluated yet {!st.running && <button className="sm ghost" onClick={async () => { await post(`/api/wallets/${c.address}/evaluate`, {}); reload(); }}>Evaluate now</button>}</td>}
                <td className="r" onClick={(e) => e.stopPropagation()}>{c.followed ? <span className="badge b-good">following</span> : <button className="sm" onClick={async () => { await post('/api/wallets', { address: c.address, label: c.userName, source: 'discovery' }); reload(); }}>Follow</button>}</td>
              </tr>))}</tbody>
          </table></div>}
      </div>
    </div>
  );
}

export default function Wallets({ tab }: { tab: string }) {
  return (
    <div>
      <div className="page-head"><div><h1>Wallets</h1><p>Follow wallets with credible, consistent histories — not just one lucky trade. Quality scores are explainable: open any wallet to see every component.</p></div></div>
      <div className="tabs"><button className={tab !== 'discover' ? 'on' : ''} onClick={() => go('/wallets')}>Watchlist</button><button className={tab === 'discover' ? 'on' : ''} onClick={() => go('/wallets?tab=discover')}>Discover</button></div>
      {tab === 'discover' ? <Discover /> : <Watchlist />}
    </div>
  );
}
void num; void dur;
