import React, { useState } from 'react';
import { usePoll, post, patch, usd, cents, dt, num, signCls, pct, ago } from '../lib';
import { U, Loading, ErrorBox, Empty, Section, Stat, Ext, goMarket } from '../components';

export function PaperBuy({ tokenId, conditionId, label }: { tokenId: string; conditionId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('250');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="sm primary" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>Paper buy</button>;
  return (
    <span className="row" onClick={(e) => e.stopPropagation()}>
      <input type="number" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ width: 90 }} aria-label="Virtual USD" />
      <button className="sm primary" disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        try { await post('/api/paper/orders', { side: 'BUY', tokenId, conditionId, usd: Number(amt), title: label }); setMsg('Recorded — fills against the next fresh order book in a few seconds. See Paper.'); }
        catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
      }}>Confirm ${amt}</button>
      <button className="sm ghost" onClick={() => setOpen(false)}>Cancel</button>
      {msg && <span className="small muted">{msg}</span>}
    </span>
  );
}

const ST: Record<string, string> = { filled: 'b-good', partial: 'b-warn', unfilled: 'b-crit', pending: 'b-accent', settled: '' };

export default function Paper() {
  const { data, error, loading, reload } = usePoll<any>('/api/paper', 10000);
  const [sel, setSel] = useState<number | null>(null);
  if (loading && !data) return <Loading rows={8} />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const acct = data.accounts.find((a: any) => a.id === sel) ?? data.accounts[0];
  const ret = acct.equity !== null ? acct.equity / acct.starting_cash - 1 : null;
  const sell = async (h: any) => { try { await post('/api/paper/orders', { side: 'SELL', tokenId: h.token_id, conditionId: h.condition_id, accountId: acct.id }); reload(); } catch (e: any) { alert(e.message); } };
  const R = data.autoRule;
  return (
    <div>
      <div className="page-head">
        <div><h1>Paper portfolio</h1><p>Forward-only simulation with virtual funds. Each decision records the signal and settings as they were, then fills against the <b>next</b> order book fetched after it — never a whale's earlier price. Fills include taker fees, book depth and extra slippage, and are estimates.</p></div>
        <div className="row">
          {data.accounts.length > 1 && <select value={acct.id} onChange={(e) => setSel(Number(e.target.value))}>{data.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
          <button onClick={async () => { const name = prompt('New paper account name', 'Experiment'); if (name) { await post('/api/paper/accounts', { name, startingCash: 10000 }); reload(); } }}>New account</button>
        </div>
      </div>
      <div className="grid g4 keep" style={{ marginBottom: 16 }}>
        <Stat label="Equity (liquidation)" value={<U v={usd(acct.equity, { compact: false })} why={`${acct.unpricedPositions} position(s) have no bid quote`} />} sub={`Start ${usd(acct.starting_cash, { compact: false })}`} />
        <Stat label="Return" value={<span className={signCls(ret)}><U v={pct(ret, 2, true)} /></span>} sub="Equity ÷ starting cash − 1, valued at best bids" />
        <Stat label="Cash" value={usd(acct.cash, { compact: false })} sub={`${acct.open} open position(s)`} />
        <Stat label="Realized" value={<span className={signCls(acct.realized)}>{usd(acct.realized, { sign: true, compact: false })}</span>} sub="Closed and settled paper trades" />
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <Section title="Automatic forward rule" right={<label className="row small"><input type="checkbox" checked={!!acct.auto_enabled} onChange={async (e) => { await patch(`/api/paper/accounts/${acct.id}`, { autoEnabled: e.target.checked }); reload(); }} /> Enabled for this account</label>}>
          <div className="small muted">When globally enabled in Settings ({R.enabled ? <b className="pos">on</b> : <b>off</b>}): buy ${R.orderUsd} when a signal is {R.states.join(' or ')}, score ≥ {R.minScore}, supporters ≥ {R.minSupport}; at most {R.maxOpen} open; {R.exitOnEnd ? 'sell when the signal ends' : 'hold to resolution'}. Applies only going forward — it never back-fills past signals.</div>
        </Section>
        <Section title="Positions" pad={false}>
          {!acct.holdings.filter((h: any) => h.shares > 1e-9).length ? <Empty title="No open paper positions">Open the Consensus page, expand a result and press “Paper buy”.</Empty> :
            <div className="table-wrap"><table>
              <thead><tr><th>Outcome</th><th className="r">Shares</th><th className="r">Avg cost</th><th className="r">Bid</th><th className="r">Liquidation value</th><th className="r">Unrealized</th><th></th></tr></thead>
              <tbody>{acct.holdings.filter((h: any) => h.shares > 1e-9).map((h: any) => (
                <tr key={h.token_id} className="clickable" onClick={() => goMarket(h.condition_id, h.token_id)}>
                  <td><span className="outcome">{h.outcome}</span> · {h.title}{h.closed && <span className="badge" style={{ marginLeft: 6 }}>market closed</span>}</td>
                  <td className="r num">{num(h.shares, 1)}</td><td className="r num"><U v={cents(h.avgCost)} /></td>
                  <td className="r num"><U v={cents(h.bid)} why="No bids or no quote yet" /> <span className="tiny faint">{ago(h.quoteAt)}</span></td>
                  <td className="r num"><U v={usd(h.liquidationValue)} /></td>
                  <td className={`r num ${signCls(h.unrealized)}`}><U v={usd(h.unrealized, { sign: true })} /></td>
                  <td className="r"><button className="sm" onClick={(e) => { e.stopPropagation(); if (confirm('Paper-sell the whole position at the next quote?')) sell(h); }}>Sell</button></td>
                </tr>))}</tbody>
            </table></div>}
        </Section>
        <Section title="Decision log" pad={false} right={<span className="small faint">Every order keeps its signal snapshot and settings version</span>}>
          {!acct.orders.length ? <Empty title="No paper orders yet" /> :
            <div className="table-wrap"><table>
              <thead><tr><th>Decided</th><th>Side</th><th>Outcome</th><th className="r">Requested</th><th>Status</th><th className="r">Fill</th><th className="r">Fees</th><th>Origin</th><th className="r">Settings v.</th></tr></thead>
              <tbody>{acct.orders.map((o: any) => {
                const snap = o.signal_snapshot ? JSON.parse(o.signal_snapshot) : null;
                return (
                  <tr key={o.id}>
                    <td className="small">{dt(o.created_at)}<div className="tiny faint">quote +{o.quote_fetched_at ? o.quote_fetched_at - o.created_at : '—'}s</div></td>
                    <td><span className={`badge ${o.side === 'BUY' ? 'b-good' : 'b-crit'}`}>{o.side}</span></td>
                    <td className="small"><span className="outcome">{o.outcome}</span> · {o.title}{snap?.score && <div className="tiny faint" title={JSON.stringify(snap, null, 1)}>at decision: {snap.state}, score {snap.score.total?.toFixed(0)}, {snap.supportCount}/{snap.eligibleUnits} supporters</div>}</td>
                    <td className="r num">{o.requested_usd ? usd(o.requested_usd) : `${num(o.requested_shares, 1)} sh`}</td>
                    <td><span className={`badge ${ST[o.status] ?? ''}`} title={o.fill_note}>{o.status}</span>{o.is_estimate ? <div className="tiny faint">estimate</div> : null}</td>
                    <td className="r num small">{o.filled_shares > 0 ? <>{num(o.filled_shares, 1)} @ {cents(o.avg_price)}</> : '—'}<div className="tiny faint" style={{ maxWidth: 260, whiteSpace: 'normal' }}>{o.fill_note}</div></td>
                    <td className="r num">{usd(o.fees)}</td>
                    <td className="small">{o.origin}</td>
                    <td className="r num">v{o.settings_version ?? '—'}{o.watchlist_version ? <div className="tiny faint">wl {o.watchlist_version}</div> : null}</td>
                  </tr>);
              })}</tbody>
            </table></div>}
        </Section>
        {acct.byVersion?.length > 0 && <Section title="Flows by settings version">
          <div className="small muted" style={{ marginBottom: 8 }}>Changing thresholds creates a new version, so results from different rules are never blended silently.</div>
          <table><thead><tr><th>Version</th><th className="r">Filled orders</th><th className="r">Bought</th><th className="r">Sold / settled</th></tr></thead>
            <tbody>{acct.byVersion.map((v: any) => <tr key={v.settings_version ?? 'x'}><td>v{v.settings_version ?? '—'}</td><td className="r">{v.n}</td><td className="r num">{usd(v.bought)}</td><td className="r num">{usd(v.sold)}</td></tr>)}</tbody></table>
        </Section>}
        <div className="note">Why no backtest: picking today's best wallets and replaying their past trades would use knowledge you didn't have then (look-ahead bias), and Polymarket offers no historical order books to fill against. Forward paper tracking is the honest alternative — give it weeks before drawing conclusions.</div>
      </div>
    </div>
  );
}
