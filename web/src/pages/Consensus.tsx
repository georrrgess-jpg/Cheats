import React, { useEffect, useState } from 'react';
import { usePoll, usd, cents, centsDelta, ago, dur, pct, isNum, signCls, num } from '../lib';
import { U, StateBadge, GradeBadge, ScoreBar, Comp, Loading, Empty, ErrorBox, Wallet, Ext, Section, goMarket } from '../components';
import { PaperBuy } from './Paper';

const WINDOWS = [[3600, '1h'], [6 * 3600, '6h'], [86400, '24h'], [7 * 86400, '7d']] as const;

export function UnitList({ units, empty }: { units: any[]; empty: string }) {
  if (!units.length) return <div className="small faint">{empty}</div>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Wallet / cluster</th><th className="r">Net shares</th><th className="r">Value</th><th className="r">Avg entry</th><th className="r">Quality</th><th className="r">Capped weight</th></tr></thead>
      <tbody>{units.map((u) => (
        <tr key={u.id}>
          <td><div className="row" style={{ gap: 4 }}>{u.wallets.map((w: any) => <Wallet key={w.address} address={w.address} label={w.label} />)}
            {u.kind !== 'wallet' && <span className={`badge ${u.kind === 'cluster' ? 'b-violet' : 'b-warn'}`} title={u.kind === 'cluster' ? 'Declared cluster: counted as one supporter' : 'Suspected link from overlapping positions: counted once (assumption, not evidence of shared ownership)'}>{u.kind === 'cluster' ? 'cluster ×1' : 'suspected link ×1'}</span>}</div></td>
          <td className="r num">{num(u.netShares, 0)}</td>
          <td className="r num"><U v={usd(u.value)} why="No current price available" /></td>
          <td className="r num"><U v={cents(u.avgPrice)} why="Provider has no average cost (e.g. tokens received by transfer or split)" /></td>
          <td className="r num">{u.qualityKnown ? Math.round(u.quality) : <span className="unavail" title="Wallet not evaluated yet; neutral 50 used">50*</span>}</td>
          <td className="r num" title="Share of exposure weight after the influence cap">{pct(u.exposureShare, 0)}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

export function Evidence({ r }: { r: any }) {
  const W = r.score.weights;
  return (
    <div className="grid g2 fade-in" style={{ padding: 16, background: 'var(--bg)', borderTop: '1px solid var(--border)' }}>
      <div className="stack">
        <h3>Supporting · {r.supportCount}</h3>
        <UnitList units={r.supporters} empty="None" />
        <h3 style={{ marginTop: 8 }}>Opposing (holds {r.outcome === 'Yes' ? 'No' : 'the other outcome'}) · {r.opposeCount}</h3>
        <UnitList units={r.opposers} empty="No followed wallet holds the opposite outcome." />
        {r.otherOutcomeHolders?.length > 0 && <><h3 style={{ marginTop: 8 }}>Other outcomes in this event (not counted as opposition)</h3>
          <ul className="list-plain small">{r.otherOutcomeHolders.map((o: any) => <li key={o.tokenId}>{o.title} — {o.units} unit(s)</li>)}</ul></>}
        {r.staleHolders?.length > 0 && <div className="note">⚠ {r.staleHolders.length} followed wallet(s) last known to hold this outcome are not counted because their data is stale: {r.staleHolders.map((s: any) => s.label || s.address.slice(0, 8)).join(', ')}.</div>}
      </div>
      <div className="stack">
        <h3>Score components (weights shown)</h3>
        <Comp label="Breadth" v={r.score.components.breadth} w={W.breadth} detail="min(1, supporters / breadth target)" />
        <Comp label="Quality" v={r.score.components.quality} w={W.quality} detail="Capped quality-weighted share of support vs opposition × mean supporter quality" />
        <Comp label="Exposure" v={r.score.components.exposure} w={W.exposure} detail="Capped USD exposure share of support vs opposition" />
        <Comp label="Momentum" v={r.score.components.momentum} w={W.momentum} detail="0.5 + 0.5 × (inflow − outflow)/(inflow + outflow) in window; 0.5 when no trades" />
        <div className="small faint">Score = 100 × Σ weight × component / Σ weights = <b>{r.score.total.toFixed(1)}</b>. It ranks agreement strength; it is not a probability of success.</div>
        <h3 style={{ marginTop: 8 }}>Flows · last {dur(r.flows.windowSec)}</h3>
        <dl className="kv">
          <dt>Inflow (buys)</dt><dd className="pos">{usd(r.flows.inflowUsd)}</dd>
          <dt>Outflow (sells)</dt><dd className="neg">{usd(r.flows.outflowUsd)}</dd>
          <dt>Increasing</dt><dd>{r.flows.increasingUnits.length} unit(s)</dd>
          <dt>Reducing / exited</dt><dd>{r.flows.reducingUnits.length} / {r.flows.exitedUnits.length}</dd>
        </dl>
        {r.flows.backfillIncluded && <div className="tiny faint">Includes historical (backfilled) trades — shown for context, never used for alerts.</div>}
        <h3 style={{ marginTop: 8 }}>Data quality</h3>
        <GradeBadge grade={r.dataQuality.grade} issues={r.dataQuality.issues} />
        {r.dataQuality.issues.length ? <ul className="list-plain small muted">{r.dataQuality.issues.map((i: string) => <li key={i}>{i}</li>)}</ul> : <div className="small muted">No issues detected.</div>}
        {r.flags.length > 0 && <><h3 style={{ marginTop: 8 }}>Interpretation notes</h3><ul className="list-plain small muted">{r.flags.map((f: string) => <li key={f}>{f}</li>)}</ul></>}
        <div className="tiny faint">Unobserved positions (other wallets, other venues) and external hedges can change what these holdings mean.</div>
        {r.signal?.reasons?.length > 0 && <div className="note"><b>{r.signal.state}:</b> {r.signal.reasons.join(' ')}</div>}
      </div>
    </div>
  );
}

export function ConsensusRow({ r, open, onToggle, compact }: { r: any; open: boolean; onToggle: () => void; compact?: boolean }) {
  const q = r.quote;
  const sig = r.signal;
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="clickable cr-grid" style={{ padding: '14px 16px', cursor: 'pointer', display: 'grid', gridTemplateColumns: compact ? '1fr auto' : 'minmax(0,2.4fr) repeat(4, minmax(0,1fr)) 150px', gap: 14, alignItems: 'center' }} onClick={onToggle}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6, marginBottom: 3 }}>
            <StateBadge state={sig?.state} title={sig?.reasons?.join(' ')} />
            <span className="badge">{r.category}</span>
            {sig?.baseline && <span className="badge" title="Already present when tracking started or when a wallet was added — not a newly formed agreement">pre-existing</span>}
          </div>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}><span className="outcome">{r.outcome}</span> · {r.title}</div>
          <div className="small faint">{r.supportCount} of {r.eligibleUnits} refreshed units support · {r.opposeCount} oppose {sig && <>· first seen {ago(sig.firstDetectedAt)} · changed {ago(sig.lastChangeAt)}</>}</div>
        </div>
        {!compact && <>
          <div><div className="tiny faint">Support / oppose $</div><div className="num"><U v={usd(r.supportValue)} /> <span className="faint">/ {usd(r.opposeValue) ?? '—'}</span></div></div>
          <div><div className="tiny faint">Ask · spread</div><div className="num">{q ? <><U v={cents(q.ask)} why="No asks in book" /> <span className="faint">· {cents(q.spread) ?? '—'}</span></> : <U v={null} why="No order book fetched yet" />}</div></div>
          <div><div className="tiny faint">Since first seen</div><div className={`num ${signCls(r.priceMoveSinceFirst)}`}><U v={centsDelta(r.priceMoveSinceFirst)} why="No mid price at first detection or now" /></div></div>
          <div><div className="tiny faint">Est. entry</div><div className="num"><U v={cents(r.entry.weightedAvgPrice)} why="No supporter average-cost data" />{isNum(r.entry.coverage) && r.entry.coverage < 0.999 && <span className="tiny faint"> ({pct(r.entry.coverage)} known)</span>}</div></div>
        </>}
        <div><ScoreBar value={r.score.total} /><div className="tiny faint" style={{ marginTop: 2 }}><GradeBadge grade={r.dataQuality.grade} issues={r.dataQuality.issues} /></div></div>
      </div>
      {open && <>
        <div className="row" style={{ padding: '0 16px 12px', gap: 8 }}>
          <button className="sm" onClick={() => goMarket(r.conditionId, r.tokenId)}>Market detail →</button>
          <Ext href={r.url}><span className="small">Open on Polymarket</span></Ext>
          <PaperBuy tokenId={r.tokenId} conditionId={r.conditionId} label={`${r.outcome} · ${r.title}`} />
          {q && <span className="small faint">Buying ${num(q.probe.usd)} now: {q.probe.fillable ? `avg ${cents(q.probe.avgPrice)} (${pct(q.probe.slippagePct, 1)} vs best ask)` : 'book too thin to fill fully'} · quote {ago(q.fetchedAt)}</span>}
        </div>
        <Evidence r={r} />
      </>}
    </div>
  );
}

export default function Consensus({ focus }: { focus: string | null }) {
  const [f, setF] = useState({ minSupport: '2', window: String(86400), category: 'All', minLiquidity: '', minPosition: '', minQuality: '', state: 'All', sort: 'score' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v !== 'All') as any).toString();
  const { data, error, loading, reload } = usePoll<any>(`/api/consensus?${qs}`, 30000);
  const [open, setOpen] = useState<string | null>(focus);
  useEffect(() => { if (focus) setOpen(focus); }, [focus]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const rows = data?.results ?? [];
  return (
    <div>
      <div className="page-head"><div><h1>Consensus</h1><p>Exact outcomes where several followed wallets currently hold the same net side. Counts use only wallets refreshed recently; exited wallets drop out automatically. Expand any row for the evidence.</p></div></div>
      <div className="card">
        <div className="filters">
          <label className="field">Min supporters<input type="number" min={1} value={f.minSupport} onChange={set('minSupport')} style={{ width: 90 }} /></label>
          <label className="field">Activity window<div className="seg">{WINDOWS.map(([s, l]) => <button key={s} className={f.window === String(s) ? 'on' : ''} onClick={() => setF({ ...f, window: String(s) })}>{l}</button>)}</div></label>
          <label className="field">Category<select value={f.category} onChange={set('category')}>{(data?.categories ?? ['All']).map((c: string) => <option key={c}>{c}</option>)}</select></label>
          <label className="field">State<select value={f.state} onChange={set('state')}>{['All', 'New agreement', 'Building', 'Stable', 'Weakening', 'Stale'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="field">Min liquidity $<input type="number" value={f.minLiquidity} onChange={set('minLiquidity')} placeholder="any" style={{ width: 100 }} /></label>
          <label className="field">Min position $<input type="number" value={f.minPosition} onChange={set('minPosition')} placeholder={String(data?.settings?.minPositionUsd ?? '')} style={{ width: 100 }} /></label>
          <label className="field">Min wallet quality<input type="number" value={f.minQuality} onChange={set('minQuality')} placeholder="0" style={{ width: 90 }} /></label>
          <label className="field">Sort<select value={f.sort} onChange={set('sort')}>
            <option value="score">Score</option><option value="support">Supporters</option><option value="value">Support $</option><option value="inflow">Net inflow</option><option value="recent">Latest change</option><option value="move">Price move</option></select></label>
        </div>
        {data && <div className="small faint" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          {rows.length} result(s) · {data.eligibleWallets} wallets with fresh data{data.staleWallets.length ? ` · ${data.staleWallets.length} stale (excluded)` : ''}
          {data.suspectedLinks.length > 0 && ` · ${data.suspectedLinks.length} suspected wallet link(s) collapsed`}
        </div>}
        {error && <ErrorBox error={error} onRetry={reload} />}
        {loading && !data ? <Loading rows={6} /> : !rows.length ? (
          <Empty title="No current agreement">{data?.eligibleWallets ? `No outcome is held by at least ${f.minSupport} independent followed wallets under these filters.` : 'Follow some wallets first (Wallets → Discover), then wait for the first position sync.'}</Empty>
        ) : rows.map((r: any) => <ConsensusRow key={r.tokenId} r={r} open={open === r.tokenId} onToggle={() => setOpen(open === r.tokenId ? null : r.tokenId)} />)}
      </div>
    </div>
  );
}
