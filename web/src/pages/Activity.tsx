import React, { useState } from 'react';
import { usePoll, usd, cents, num, dt, ago, dur } from '../lib';
import { U, Loading, ErrorBox, Empty, Wallet, Ext, goMarket } from '../components';

/** What each activity type means — not every row is a new directional bet. */
const TYPE_INFO: Record<string, { cls: string; tip: string }> = {
  TRADE: { cls: '', tip: 'An order-book trade: a directional buy or sell of one outcome.' },
  SPLIT: { cls: 'b-violet', tip: 'Collateral converted into a full set of outcomes (no directional view by itself).' },
  MERGE: { cls: 'b-violet', tip: 'A full set of outcomes converted back to collateral (reduces both sides; not a bet).' },
  REDEEM: { cls: 'b-good', tip: 'Redeeming resolved tokens for their payout. Not a new position.' },
  CONVERSION: { cls: 'b-violet', tip: 'Multi-outcome conversion (e.g. NO shares into YES on other outcomes). Changes exposure without an order-book trade.' },
  TRANSFER: { cls: '', tip: 'Token migration/transfer. Not a trade.' },
  REWARD: { cls: '', tip: 'Rewards / yield income. Not a position.' },
  REBATE: { cls: '', tip: 'Fee rebate income. Not a position.' },
  OTHER: { cls: '', tip: 'Other activity.' },
};

export function ActivityTable({ rows, hideWallet }: { rows: any[]; hideWallet?: boolean }) {
  if (!rows?.length) return <Empty title="No activity stored">Activity appears after the first sync. Initial history covers the configured backfill window.</Empty>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Trade time</th>{!hideWallet && <th>Wallet</th>}<th>Type</th><th>Outcome · market</th><th className="r">Shares</th><th className="r">Price</th><th className="r">Notional</th><th className="hide-sm">Observed</th><th></th></tr></thead>
      <tbody>{rows.map((a) => {
        const info = TYPE_INFO[a.type] ?? TYPE_INFO.OTHER;
        const lag = a.observed_at - a.ts;
        return (
          <tr key={a.id} className={a.condition_id ? 'clickable' : ''} onClick={() => a.condition_id && goMarket(a.condition_id, a.token_id)}>
            <td className="small num">{dt(a.ts)}</td>
            {!hideWallet && <td><Wallet address={a.wallet} label={a.label} /></td>}
            <td><span className={`badge ${a.type === 'TRADE' ? (a.side === 'BUY' ? 'b-good' : 'b-crit') : info.cls}`} title={`${info.tip} (raw: ${a.raw_type})`}>{a.type === 'TRADE' ? a.side : a.raw_type}</span></td>
            <td className="small" style={{ maxWidth: 420 }}>{a.outcome ? <span className="outcome">{a.outcome}</span> : <span className="faint">{a.type === 'TRADE' ? '?' : 'all outcomes'}</span>} · {a.title ?? a.condition_id?.slice(0, 12)}</td>
            <td className="r num">{num(a.size, 1) ?? '—'}</td>
            <td className="r num">{a.type === 'TRADE' ? <U v={cents(a.price)} /> : '—'}</td>
            <td className="r num"><U v={usd(a.usdc_size)} /></td>
            <td className="small hide-sm" title={`First observed ${new Date(a.observed_at * 1000).toLocaleString()}`}>{a.is_backfill ? <span className="badge" title="Loaded as history (initial backfill or recovery after downtime). Never triggers alerts.">history</span> : <span className="faint">+{dur(lag)}</span>}</td>
            <td onClick={(e) => e.stopPropagation()}>{a.txUrl && <Ext href={a.txUrl}><span className="tiny">tx</span></Ext>}</td>
          </tr>);
      })}</tbody>
    </table></div>
  );
}

export default function Activity({ initialWallet }: { initialWallet: string }) {
  const [f, setF] = useState({ q: '', type: 'All', side: 'All', minUsd: '', live: false, wallet: initialWallet });
  const qs = new URLSearchParams({ limit: '200', ...(f.q && { q: f.q }), ...(f.type !== 'All' && { type: f.type }), ...(f.side !== 'All' && { side: f.side }), ...(f.minUsd && { minUsd: f.minUsd }), ...(f.live && { live: '1' }), ...(f.wallet && { wallet: f.wallet }) }).toString();
  const { data, error, loading, reload, at } = usePoll<any>(`/api/activity?${qs}`, 15000);
  return (
    <div>
      <div className="page-head"><div><h1>Activity</h1><p>Every stored event from followed wallets. Trade time comes from the chain; “observed” is when this app first saw it. Splits, merges, conversions and redemptions are labelled by meaning — they are not counted as new bets.</p></div>
        <span className="small faint">updated {at ? ago(at / 1000) : '…'}</span></div>
      <div className="card">
        <div className="filters">
          <label className="field" style={{ flex: '1 1 220px' }}>Search market or wallet<input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="e.g. Fed, Lakers, 0xabc" /></label>
          <label className="field">Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['All', 'TRADE', 'SPLIT', 'MERGE', 'REDEEM', 'CONVERSION', 'TRANSFER', 'REWARD', 'REBATE'].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="field">Side<select value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}>{['All', 'BUY', 'SELL'].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="field">Min notional $<input type="number" value={f.minUsd} onChange={(e) => setF({ ...f, minUsd: e.target.value })} style={{ width: 100 }} /></label>
          <label className="row small" style={{ paddingBottom: 8 }}><input type="checkbox" checked={f.live} onChange={(e) => setF({ ...f, live: e.target.checked })} /> Live only (exclude history)</label>
          {f.wallet && <button className="sm" onClick={() => setF({ ...f, wallet: '' })}>Wallet: {f.wallet.slice(0, 8)}… ✕</button>}
        </div>
        {error && <ErrorBox error={error} onRetry={reload} />}
        {loading && !data ? <Loading rows={8} /> : <ActivityTable rows={data?.rows ?? []} />}
      </div>
    </div>
  );
}
