import React, { useState } from 'react';
import { usePoll, post, usd, pct, cents, ago, dt, num, signCls } from '../lib';
import { U, Loading, ErrorBox, Section, Stat, Wallet, Ext, Comp, LineChart, ScoreBar, goMarket } from '../components';
import { ActivityTable } from './Activity';

const COMP_LABEL: Record<string, string> = { consistency: 'Consistency', edge: 'Edge (ROI)', sample: 'Sample size', recency: 'Recency', concentration: 'Diversification', completeness: 'Data completeness' };

export default function WalletDetail({ address }: { address: string }) {
  const { data, error, loading, reload } = usePoll<any>(`/api/wallets/${address}`, 30000);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Loading rows={8} />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const m = data.metrics;
  const w = data.wallet;
  const evaluate = async () => { setBusy(true); try { await post(`/api/wallets/${address}/evaluate`, {}); await reload(); } catch (e: any) { alert(e.message); } finally { setBusy(false); } };
  const follow = async () => { await post('/api/wallets', { address, label: data.candidate?.user_name }); reload(); };
  return (
    <div>
      <div className="page-head">
        <div>
          <a href="#/wallets" className="small">← Wallets</a>
          <h1 style={{ marginTop: 6 }} className="row"><Wallet address={address} label={w?.label || data.candidate?.user_name} link={false} /></h1>
          <p className="mono">{address} · <Ext href={data.links.profile}>Polymarket profile</Ext></p>
        </div>
        <div className="row">
          {!w?.followed && <button className="primary" onClick={follow}>Follow</button>}
          <button onClick={evaluate} disabled={busy}>{busy ? 'Evaluating…' : 'Re-evaluate'}</button>
        </div>
      </div>
      {!m ? <Section title="Not evaluated yet"><div className="muted">Evaluation is queued, or press Re-evaluate.</div></Section> : <>
        <div className="grid g4 keep" style={{ marginBottom: 16 }}>
          <Stat label="Quality score (ours)" value={<ScoreBar value={m.score.total} />} sub={`computed ${ago(m.computedAt)} · settings v${data.metricsSettingsVersion ?? '—'}`} />
          <Stat label="Win rate" value={<U v={pct(m.winRate)} />} sub={`${m.wins} wins / ${m.losses} losses of ${m.sample.resolved} resolved/exited`} />
          <Stat label="Realized ROI (sample)" value={<span className={signCls(m.realized.sample.roi)}><U v={pct(m.realized.sample.roi, 1, true)} /></span>} sub="Σ PnL ÷ Σ cost basis of those positions" />
          <Stat label="Max drawdown" value={<U v={usd(m.series.maxDrawdown)} why="No PnL series" />} sub={m.series.days ? `over ${Math.round(m.series.days)} days of marked PnL` : 'no series'} />
        </div>
        <div className="grid g2" style={{ marginBottom: 16 }}>
          <Section title="Why this score">
            <div className="stack" style={{ gap: 8 }}>
              {Object.entries(m.score.components).map(([k, c]: any) => (
                <div key={k}><Comp label={COMP_LABEL[k] ?? k} v={c.available ? c.score : null} w={m.score.weights[k]} detail={c.detail} /><div className="tiny faint" style={{ marginLeft: 120 }}>{c.detail}</div></div>
              ))}
            </div>
            <div className="divider" />
            <h3>Flags</h3>
            {!m.flags.length ? <div className="small muted">No warning flags.</div> : <ul className="list-plain small">{m.flags.map((f: any) => <li key={f.code} className={f.severity === 'warning' ? 'neg' : 'muted'}>{f.text}</li>)}</ul>}
          </Section>
          <Section title="Cumulative trading PnL (provider series, marked)">
            {m.series.available ? <LineChart label="Cumulative PnL" points={m.series.points} format={(v) => usd(v) ?? ''} /> : <div className="muted small">Unavailable — the provider returned no PnL series for this wallet.</div>}
            <div className="tiny faint" style={{ marginTop: 6 }}>Source: Polymarket /v2/user-pnl position_pnl (realized + unrealized). {m.series.months} thirty-day periods, {m.series.positiveMonths} positive. Last 30 days: <span className={signCls(m.series.pnl30d)}>{usd(m.series.pnl30d, { sign: true }) ?? 'Unavailable'}</span>.</div>
          </Section>
        </div>
        <div className="grid g3" style={{ marginBottom: 16 }}>
          <Section title="Realized by period (our calc)">
            <table><thead><tr><th>Period</th><th className="r">Positions</th><th className="r">PnL</th><th className="r">ROI</th></tr></thead>
              <tbody>{(['d30', 'd90', 'd365', 'sample'] as const).map((k) => { const r = m.realized[k]; return (
                <tr key={k}><td>{{ d30: '30 days', d90: '90 days', d365: '365 days', sample: 'Whole sample' }[k]}</td>
                  <td className="r num">{r.available ? r.count : '—'}</td>
                  <td className={`r num ${signCls(r.pnl)}`}><U v={r.available ? usd(r.pnl, { sign: true }) : null} why={r.note} /></td>
                  <td className="r num"><U v={pct(r.roi, 1)} why={r.note || 'No cost basis'} /></td></tr>); })}</tbody></table>
            <div className="tiny faint" style={{ marginTop: 8 }}>{m.sample.note} {m.sample.truncated && `Sample capped at ${m.sample.closedFetched} closed positions.`}</div>
          </Section>
          <Section title="Concentration">
            <dl className="kv">
              <dt>Largest win share</dt><dd><U v={pct(m.concentration.top1Share)} /></dd>
              <dt>Top-3 share</dt><dd><U v={pct(m.concentration.top3Share)} /></dd>
              <dt>Gross profit</dt><dd>{usd(m.concentration.grossProfit)}</dd>
              <dt>Biggest win</dt><dd><U v={usd(m.concentration.biggestWin)} /></dd>
            </dl>
            {m.concentration.biggestWinTitle && <div className="tiny faint" style={{ marginTop: 6 }}>{m.concentration.biggestWinTitle}</div>}
            <div className="divider" />
            <h3>Behaviour (uncertain)</h3>
            <dl className="kv">
              <dt>Fills per market</dt><dd><U v={num(m.behavior.tradesPerMarket, 0)} /></dd>
              <dt>Maker rebates / PnL</dt><dd><U v={pct(m.behavior.makerRebateShare)} /></dd>
              <dt>Two-sided markets</dt><dd>{m.behavior.twoSidedConditions}</dd>
            </dl>
          </Section>
          <Section title="Category mix (resolved PnL)">
            {!m.categories.length ? <div className="muted small">No resolved positions.</div> :
              <table><tbody>{m.categories.slice(0, 8).map((c: any) => <tr key={c.category}><td>{c.category}</td><td className="r num">{c.count}</td><td className={`r num ${signCls(c.pnl)}`}>{usd(c.pnl, { sign: true })}</td></tr>)}</tbody></table>}
            <div className="tiny faint" style={{ marginTop: 6 }}>Categories from market tags for the 200 largest positions; others are “Unclassified”.</div>
            {m.provider.stats && <><div className="divider" /><h3>Provider-reported</h3><dl className="kv">
              <dt>Markets traded</dt><dd><U v={num(m.provider.stats.marketsTraded)} /></dd>
              <dt>All-time realized</dt><dd><U v={usd(m.provider.stats.allTimeRealizedPnl)} /></dd>
              <dt>Volume (USD)</dt><dd><U v={usd(m.provider.stats.volumeUsd)} /></dd>
              <dt>Joined</dt><dd><U v={dt(m.provider.stats.joinDate)} /></dd></dl></>}
          </Section>
        </div>
      </>}
      <div className="grid" style={{ gap: 16 }}>
        <Section title={`Current positions (${data.positions.filter((p: any) => !p.redeemable).length} live)`} pad={false} right={data.sync?.positions_synced_at ? <span className="small faint">reconciled {ago(data.sync.positions_synced_at)}</span> : <span className="small faint">{w?.followed ? 'not yet reconciled' : 'only tracked for followed wallets'}</span>}>
          {!data.positions.length ? <div className="card-pad muted small">No stored positions.</div> :
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}><table>
              <thead><tr><th>Outcome · market</th><th className="r">Shares</th><th className="r">Avg</th><th className="r">Mark</th><th className="r">Value</th><th className="r">Unrealized</th><th>Entered</th></tr></thead>
              <tbody>{data.positions.map((p: any) => (
                <tr key={p.token_id} className="clickable" onClick={() => goMarket(p.condition_id, p.token_id)} style={{ opacity: p.redeemable ? 0.55 : 1 }}>
                  <td className="small"><span className="outcome">{p.outcome}</span> · {p.title}{p.redeemable ? <span className="badge" style={{ marginLeft: 6 }}>resolved</span> : null}</td>
                  <td className="r num">{num(p.size, 0)}</td><td className="r num"><U v={cents(p.avg_price)} /></td><td className="r num"><U v={cents(p.current_price)} /></td>
                  <td className="r num">{usd(p.current_value)}</td><td className={`r num ${signCls(p.unrealized_pnl)}`}><U v={usd(p.unrealized_pnl, { sign: true })} /></td>
                  <td className="small">{ago(p.first_entry_at) ?? '—'}</td>
                </tr>))}</tbody></table></div>}
        </Section>
        <Section title="Recent activity" pad={false}><ActivityTable rows={data.activity} hideWallet /></Section>
      </div>
    </div>
  );
}
