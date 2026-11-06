import React, { useEffect, useState } from 'react';
import { usePoll, put, ago, dt, dur } from '../lib';
import { Loading, ErrorBox, Section, Wallet, Fresh } from '../components';

const HELP: Record<string, string> = {
  activityPollSec: 'Seconds between activity polls per wallet', positionsPollSec: 'Seconds between position reconciliations per wallet', quotesPollSec: 'Seconds between order-book refreshes',
  initialBackfillDays: 'History loaded when a wallet is first followed', liveObservationLagSec: 'Activity seen later than this after it happened is "history" (no alerts)',
  staleAfterSec: 'Wallet excluded from consensus if positions older than this', minPositionUsd: 'Ignore holdings smaller than this (USD)', minSupport: 'Independent supporters needed for a consensus result',
  breadthTarget: 'Supporters at which breadth saturates', maxInfluenceShare: 'Max share of weight any one wallet/cluster can carry', minQualityScore: 'Wallets below this quality are ignored',
  collapseSuspectedLinks: 'Count wallets with near-identical holdings as one (conservative)', linkJaccard: 'Holding-set overlap that marks a suspected link', recentWindowSec: 'Default inflow/outflow window',
  trendLookbackSec: 'Compare with snapshot this long ago (Building / Weakening)', newWindowSec: '"New agreement" lasts this long', changeExposurePct: 'Relative exposure change counted as meaningful',
  quoteStaleSec: 'Quotes older than this make a signal Stale', depthProbeUsd: 'Order size used to report executable depth',
  convergenceMinSupport: 'Alert when support crosses this', increaseMinDelta: 'Alert when supporters grow by this within lookback', exitMinWallets: 'Alert when this many supporters reduce/exit', exitReducePct: 'Reduction share counted as "reducing"',
  cooldownSec: 'Minimum seconds between repeats of the same alert', defaultOrderUsd: 'Default paper order size', maxSlippagePct: 'Paper limit = best price ± this', extraSlippageBps: 'Extra slippage added to every simulated fill', simulatedLatencySec: 'Fill uses a book fetched at least this long after the decision',
};

function Field({ k, v, onChange }: { k: string; v: any; onChange: (v: any) => void }) {
  if (typeof v === 'boolean') return <label className="row small" title={HELP[k]}><input type="checkbox" checked={v} onChange={(e) => onChange(e.target.checked)} /> {k}</label>;
  if (typeof v === 'number') return <label className="field" title={HELP[k]}>{k}<input type="number" step="any" value={v} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} /><span className="tiny faint">{HELP[k] ?? ''}</span></label>;
  return <label className="field" style={{ gridColumn: '1/-1' }}>{k}<textarea rows={3} className="mono" defaultValue={JSON.stringify(v)} onBlur={(e) => { try { onChange(JSON.parse(e.target.value)); } catch { alert(`${k}: invalid JSON`); } }} /></label>;
}

function Group({ title, obj, onChange }: { title: string; obj: any; onChange: (o: any) => void }) {
  return (
    <Section title={title}>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 }}>
        {Object.entries(obj).map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v))
          ? <div key={k} style={{ gridColumn: '1/-1' }}><h3>{k}</h3><div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>{Object.entries(v as any).map(([k2, v2]) => <Field key={k2} k={k2} v={v2} onChange={(nv) => onChange({ ...obj, [k]: { ...(v as any), [k2]: nv } })} />)}</div></div>
          : <Field key={k} k={k} v={v} onChange={(nv) => onChange({ ...obj, [k]: nv })} />)}
      </div>
    </Section>
  );
}

export default function Settings() {
  const s = usePoll<any>('/api/settings', 0);
  const h = usePoll<any>('/api/health', 10000);
  const [draft, setDraft] = useState<any>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (s.data && !draft) setDraft(structuredClone(s.data.settings)); }, [s.data]);
  if ((s.loading && !s.data) || !draft) return <Loading rows={8} />;
  if (s.error) return <ErrorBox error={s.error} onRetry={s.reload} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(s.data.settings);
  const save = async () => { try { const r: any = await put('/api/settings', { patch: draft, note: note || 'Edited in UI' }); setMsg(`Saved as version ${r.version}. Paper results remain grouped by version.`); setNote(''); s.reload(); } catch (e: any) { setMsg(e.message); } };
  const H = h.data;
  return (
    <div>
      <div className="page-head"><div><h1>Settings & health</h1><p>Every threshold is configurable. Saving creates a new immutable settings version; paper orders and signals record the version in force so results stay interpretable.</p></div>
        <div className="row"><span className="badge">active v{s.data.version}</span></div></div>
      <div className="grid" style={{ gap: 16 }}>
        <Section title="Tracking health" pad={false}>
          {!H ? <Loading /> : <>
            <div className="card-pad">
              <dl className="kv">
                <dt>Data source</dt><dd>{H.demo ? 'DEMO fixture (synthetic)' : `${H.platform} public APIs (no API key required)`}</dd>
                <dt>Worker</dt><dd>{H.worker?.running ? `running since ${dt(H.worker.startedAt)} · cycle ${H.worker.cycle} · last tick ${ago(H.worker.lastTickAt)}` : H.worker?.note || 'stopped'}</dd>
                {H.worker?.lastError && <><dt>Last worker error</dt><dd className="neg small">{H.worker.lastError}</dd></>}
                <dt>Avg trade→observed lag</dt><dd>{H.observedLagSec != null ? `${dur(H.observedLagSec)} over last ${H.observedLagSample} live events` : 'no live events yet'}</dd>
                {H.hosts.map((x: any) => <React.Fragment key={x.host}><dt>{x.host}</dt><dd className="small">{x.requests} requests · last ok {ago(x.lastOkAt) ?? 'never'} · {x.lastLatencyMs ?? '—'} ms · rate-limited {x.rateLimited}× {x.consecutiveFailures ? <span className="neg">· {x.consecutiveFailures} consecutive failures: {x.lastError}</span> : null}</dd></React.Fragment>)}
              </dl>
              <div className="note" style={{ marginTop: 12 }}>Continuous tracking only happens while the WhaleSignal server process is running. After a restart it resumes from the last stored cursor per wallet and backfills missed activity (marked as history, never alerted).</div>
            </div>
            <div className="table-wrap"><table>
              <thead><tr><th>Wallet</th><th>Positions</th><th>Activity</th><th>Backfill</th><th>Errors</th></tr></thead>
              <tbody>{H.walletSync.map((w: any) => <tr key={w.address}><td><Wallet address={w.address} label={w.label} /></td><td><Fresh ts={w.positions_synced_at} staleAfter={H.staleAfterSec} />{w.positions_truncated ? <span className="badge b-warn">truncated</span> : null}</td><td><Fresh ts={w.activity_synced_at} /></td>
                <td className="small">{w.backfill_done ? `complete from ${dt(w.backfill_from)}` : w.activity_synced_at ? 'in progress' : '—'}</td>
                <td className="small neg">{w.positions_error || w.activity_error || ''}</td></tr>)}</tbody></table></div>
          </>}
        </Section>
        <Group title="Consensus" obj={draft.consensus} onChange={(o) => setDraft({ ...draft, consensus: o })} />
        <Group title="Wallet scoring" obj={draft.scoring} onChange={(o) => setDraft({ ...draft, scoring: o })} />
        <Group title="Alerts" obj={draft.alerts} onChange={(o) => setDraft({ ...draft, alerts: o })} />
        <Group title="Paper trading" obj={draft.paper} onChange={(o) => setDraft({ ...draft, paper: o })} />
        <Group title="Tracking" obj={draft.tracking} onChange={(o) => setDraft({ ...draft, tracking: o })} />
        <Group title="Discovery" obj={draft.discovery} onChange={(o) => setDraft({ ...draft, discovery: o })} />
        <div className="card card-pad row" style={{ position: 'sticky', bottom: 12 }}>
          <input placeholder="Why are you changing this? (stored with the version)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
          <button disabled={!dirty} onClick={() => setDraft(structuredClone(s.data.settings))}>Discard</button>
          <button onClick={() => setDraft(structuredClone(s.data.defaults))}>Load defaults</button>
          <button className="primary" disabled={!dirty} onClick={save}>Save new version</button>
          {msg && <span className="small muted" style={{ flexBasis: '100%' }}>{msg}</span>}
        </div>
        <div className="grid g2">
          <Section title="Settings versions" pad={false}><table><tbody>{s.data.versions.map((v: any) => <tr key={v.id}><td>v{v.id}</td><td className="small">{dt(v.created_at)}</td><td className="small muted">{v.note}</td></tr>)}</tbody></table></Section>
          <Section title="Watchlist versions" pad={false}><table><tbody>{s.data.watchlistVersions.map((v: any) => <tr key={v.id}><td>wl{v.id}</td><td className="small">{dt(v.created_at)}</td><td className="small">{v.n} wallets</td><td className="small muted">{v.reason}</td></tr>)}</tbody></table></Section>
        </div>
      </div>
    </div>
  );
}
