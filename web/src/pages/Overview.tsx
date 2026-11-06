import React, { useState } from 'react';
import { usePoll, ago, dt, dur, go } from '../lib';
import { Loading, ErrorBox, Empty, Section, Stat, StateBadge, Fresh } from '../components';
import { ConsensusRow } from './Consensus';

export default function Overview() {
  const { data, error, loading, reload } = usePoll<any>('/api/overview', 20000);
  const [open, setOpen] = useState<string | null>(null);
  if (loading && !data) return <Loading rows={8} />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const h = data.health;
  if (!h.wallets.followed) return (
    <div className="card"><Empty title="Welcome to WhaleSignal">
      <p>Start by following 10–50 wallets with credible histories.</p>
      <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
        <button className="primary" onClick={() => go('/wallets?tab=discover')}>Discover wallets</button>
        <button onClick={() => go('/wallets')}>Add a wallet manually</button>
      </div>
    </Empty></div>
  );
  return (
    <div>
      <div className="page-head"><div><h1>Overview</h1><p>Strongest current agreement among followed wallets, what changed recently, and whether tracking is healthy.</p></div></div>
      <div className="grid g4 keep" style={{ marginBottom: 16 }}>
        <Stat label="Wallets with fresh data" value={`${h.wallets.fresh} / ${h.wallets.followed}`} sub={h.wallets.stale ? `${h.wallets.stale} stale — excluded from counts` : `refreshed within ${dur(h.staleAfterSec)}`} />
        <Stat label="Current agreements" value={data.totals.results} sub={`≥ minimum supporters, across ${data.totals.eligibleWallets} wallets`} />
        <Stat label="Activity (24h)" value={data.activity24h} sub="followed-wallet events stored" />
        <Stat label="Last position sync" value={<Fresh ts={h.lastPositionsSync} staleAfter={h.staleAfterSec} />} sub={h.observedLagSec != null ? `avg trade→observed lag ${dur(h.observedLagSec)} (n=${h.observedLagSample})` : 'observe lag: no live trades yet'} />
      </div>
      <div className="grid g-main">
        <Section title="Strongest current agreement" pad={false} right={<a href="#/consensus" className="small">All results →</a>}>
          {!data.top.length ? <Empty title="No agreement yet">{h.worker?.baselineDone ? 'No outcome is currently held by the minimum number of followed wallets.' : 'Waiting for the first full position sync of every followed wallet…'}</Empty> :
            data.top.map((r: any) => <ConsensusRow key={r.tokenId} r={r} compact open={open === r.tokenId} onToggle={() => setOpen(open === r.tokenId ? null : r.tokenId)} />)}
        </Section>
        <div className="stack" style={{ gap: 16 }}>
          <Section title="Meaningful changes" pad={false}>
            {!data.changes.length ? <Empty title="Nothing yet" /> : data.changes.map((s: any) => (
              <div key={s.id} className="clickable" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => go(`/market/${s.condition_id}?t=${s.token_id}`)}>
                <div className="spread"><StateBadge state={s.state} /><span className="tiny faint">{ago(s.last_change_at)}</span></div>
                <div className="small" style={{ marginTop: 4 }}><b>{s.outcome ?? '?'}</b> · {s.title ?? s.condition_id.slice(0, 12)}</div>
                <div className="tiny faint">{s.support} supporters (peak {s.peak_support}) · {s.reasons?.[0] ?? ''}</div>
              </div>))}
          </Section>
          <Section title="Recent alerts" pad={false}>
            {!data.alerts.length ? <Empty title="No alerts">Signals present when tracking started are a baseline and do not alert.</Empty> : data.alerts.map((a: any) => (
              <div key={a.id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                <div className="small" style={{ fontWeight: 600 }}>{a.title}</div><div className="tiny faint">{dt(a.created_at)}</div>
              </div>))}
          </Section>
          <Section title="Tracking health">
            <dl className="kv">
              <dt>Worker</dt><dd>{h.worker?.running ? `running · cycle ${h.worker.cycle}` : 'stopped'}</dd>
              <dt>Last consensus</dt><dd>{ago(h.worker?.lastConsensusAt) ?? 'not yet'}</dd>
              <dt>Last quotes</dt><dd>{ago(h.worker?.lastQuotesAt) ?? 'not yet'}</dd>
              {h.hosts.map((x: any) => <React.Fragment key={x.host}><dt>{x.host.split('.')[0]}</dt><dd className={x.consecutiveFailures ? 'neg' : ''}>{x.consecutiveFailures ? `${x.consecutiveFailures} failures` : `ok ${ago(x.lastOkAt) ?? ''}`} <span className="faint">· {x.requests} req</span></dd></React.Fragment>)}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
