import React, { useState } from 'react';
import { usePoll, usd, cents, centsDelta, ago, dt, num, isNum, signCls, pct } from '../lib';
import { U, Loading, ErrorBox, Section, Stat, Ext, LineChart, StateBadge, Wallet, Empty } from '../components';
import { UnitList, Evidence } from './Consensus';
import { ActivityTable } from './Activity';
import { PaperBuy } from './Paper';

function Book({ q }: { q: any }) {
  if (!q) return <div className="small muted">No order book fetched yet for this outcome.</div>;
  const rows = (side: any[]) => side.slice(0, 6);
  return (
    <div className="grid g2" style={{ gap: 12 }}>
      {[['Bids', rows(q.bids), 'pos'], ['Asks', rows(q.asks), 'neg']].map(([t, lv, cls]: any) => (
        <div key={t}><h3>{t}</h3>{!lv.length ? <div className="small faint">empty</div> :
          <table><tbody>{lv.map((l: any, i: number) => <tr key={i}><td className={`num ${cls}`}>{cents(l.price)}</td><td className="r num">{num(l.size, l.size < 10 ? 2 : 0)}</td><td className="r num faint">{usd(l.size * l.price)}</td></tr>)}</tbody></table>}</div>
      ))}
      <div className="tiny faint" style={{ gridColumn: '1/-1' }}>Fetched {ago(q.fetchedAt)} from the public CLOB book. Liquidity can change between refreshes.</div>
    </div>
  );
}

export default function Market({ conditionId, token }: { conditionId: string; token: string | null }) {
  const { data, error, loading, reload } = usePoll<any>(`/api/markets/${conditionId}`, 30000);
  const [sel, setSel] = useState<string | null>(token);
  if (loading && !data) return <Loading rows={8} />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  const m = data.market;
  const tokens: string[] = m?.tokenIds ?? data.outcomes.map((o: any) => o.tokenId);
  const cur = sel && tokens.includes(sel) ? sel : data.outcomes[0]?.tokenId ?? tokens[0];
  const idx = m ? m.tokenIds.indexOf(cur) : -1;
  const label = idx >= 0 ? m.outcomes[idx] : data.outcomes.find((o: any) => o.tokenId === cur)?.outcome;
  const r = data.outcomes.find((o: any) => o.tokenId === cur);
  const q = data.quotes[cur];
  const hist = (data.history[cur] ?? null) as any[] | null;
  const sigs = data.signals.filter((s: any) => s.token_id === cur);
  const snaps = data.snapshots.filter((s: any) => sigs.some((g: any) => g.id === s.signal_id));
  const refs = [] as { v: number; label: string }[];
  if (r?.entry?.weightedAvgPrice != null) refs.push({ v: r.entry.weightedAvgPrice, label: 'supporters avg entry' });
  if (sigs[0]?.first_price != null) refs.push({ v: sigs[0].first_price, label: 'first observed' });
  const mid = q && q.bestBid != null && q.bestAsk != null ? (q.bestBid + q.bestAsk) / 2 : null;
  const holdersCur = data.holders.filter((h: any) => h.token_id === cur);
  return (
    <div>
      <div className="page-head">
        <div>
          <a href="#/consensus" className="small">← Consensus</a>
          <h1 style={{ marginTop: 6 }}>{m?.question ?? r?.title ?? conditionId}</h1>
          <p className="row" style={{ gap: 8 }}>
            {m && <span className="badge">{m.category}</span>}
            {m?.closed ? <span className="badge b-crit">closed</span> : m?.active ? <span className="badge b-good">open</span> : null}
            {m?.negRisk && <span className="badge" title="One of several mutually exclusive outcome markets in an event">multi-outcome event</span>}
            {m?.eventTitle && <span className="small muted">{m.eventTitle}</span>}
            {m?.endDate && <span className="small faint">ends {new Date(m.endDate).toLocaleDateString()}</span>}
            <Ext href={m?.url}><span className="small">Polymarket</span></Ext>
          </p>
          {!m && <div className="small neg">Market metadata unavailable — category, fees and resolution status unknown.</div>}
        </div>
      </div>
      <div className="seg" style={{ marginBottom: 16 }}>
        {tokens.map((t, i) => <button key={t} className={t === cur ? 'on' : ''} onClick={() => setSel(t)}>{m?.outcomes[i] ?? data.outcomes.find((o: any) => o.tokenId === t)?.outcome ?? `Outcome ${i + 1}`}</button>)}
      </div>
      <div className="grid g4 keep" style={{ marginBottom: 16 }}>
        <Stat label={`Supporters of “${label}”`} value={r ? `${r.supportCount}` : '0'} sub={r ? `of ${r.eligibleUnits} refreshed units · ${r.opposeCount} opposing` : 'no followed wallet holds this outcome'} />
        <Stat label="Mid · spread" value={<U v={cents(mid)} why="One side of the book is empty or no quote" />} sub={q ? `bid ${cents(q.bestBid) ?? '—'} · ask ${cents(q.bestAsk) ?? '—'}` : 'no quote'} />
        <Stat label="Est. supporter entry" value={<U v={cents(r?.entry?.weightedAvgPrice)} />} sub={r && isNum(mid) && isNum(r.entry.weightedAvgPrice) ? <span className={signCls(mid - r.entry.weightedAvgPrice)}>now {centsDelta(mid - r.entry.weightedAvgPrice)} vs their entry</span> : 'provider average cost'} />
        <Stat label="Since first observed" value={<span className={signCls(r?.priceMoveSinceFirst)}><U v={centsDelta(r?.priceMoveSinceFirst)} /></span>} sub={sigs[0] ? `first seen ${dt(sigs[0].first_detected_at)} at ${cents(sigs[0].first_price) ?? '—'}` : 'never a consensus signal'} />
      </div>
      {r && isNum(mid) && isNum(r.entry.weightedAvgPrice) && Math.abs(mid - r.entry.weightedAvgPrice) >= 0.1 && <div className="note" style={{ marginBottom: 16 }}>⚠ The price has moved {centsDelta(mid - r.entry.weightedAvgPrice)} since supporters' average entry. You cannot obtain their earlier price; the risk/reward at {cents(mid)} is different from theirs.</div>}
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <Section title={`Price of “${label}” · 30 days`}>
          {hist === null ? <div className="small muted">Price history unavailable from the provider.</div> : <LineChart label="Price" points={hist.map((p) => ({ ts: p.ts, v: p.price }))} format={(v) => cents(v) ?? ''} refs={refs} />}
        </Section>
        <Section title="Supporter count over time">
          {snaps.length < 2 ? <Empty title="Not enough signal history">Snapshots accumulate while the app runs.</Empty> : <LineChart label="Supporters" points={snaps.map((s: any) => ({ ts: s.ts, v: s.support }))} format={(v) => num(v, 0) ?? ''} />}
          {sigs.length > 0 && <div className="row small" style={{ marginTop: 8 }}>{sigs.map((s: any) => <span key={s.id}><StateBadge state={s.state} /> <span className="faint">{dt(s.first_detected_at)} → {s.ended_at ? dt(s.ended_at) : 'now'} · peak {s.peak_support}</span></span>)}</div>}
        </Section>
      </div>
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <Section title="Order book" right={r && <PaperBuy tokenId={cur} conditionId={r.conditionId} label={`${label} · ${m?.question ?? ''}`} />}><Book q={q} /></Section>
        <Section title="Who holds what (followed wallets)" pad={false}>
          {r ? <div className="card-pad"><UnitList units={r.supporters} empty="—" /></div> : holdersCur.length ? <div className="card-pad small muted">Holdings below the dust threshold or stale.</div> : <Empty title="No followed wallet holds this outcome" />}
        </Section>
      </div>
      {r && <div className="card" style={{ marginBottom: 16 }}><div className="card-head"><h2>Full evidence for “{label}”</h2></div><Evidence r={r} /></div>}
      <div className="grid g2">
        <Section title="Exposure changes (reconciled)" pad={false}>
          {!data.changes.length ? <Empty title="No recorded changes" /> : <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}><table>
            <thead><tr><th>When</th><th>Wallet</th><th>Outcome</th><th className="r">Shares</th><th></th></tr></thead>
            <tbody>{data.changes.map((c: any) => {
              const i = m ? m.tokenIds.indexOf(c.token_id) : -1;
              return <tr key={c.id}><td className="small">{dt(c.ts)}</td><td><Wallet address={c.wallet} label={c.label} /></td><td className="outcome small">{i >= 0 ? m.outcomes[i] : '?'}</td>
                <td className="r num small">{num(c.prev_size, 0)} → <b className={c.new_size > c.prev_size ? 'pos' : 'neg'}>{num(c.new_size, 0)}</b></td>
                <td>{c.is_baseline ? <span className="badge" title="First sync or after a gap — not treated as a live change">baseline</span> : c.new_size === 0 ? <span className="badge b-crit">exit</span> : null}</td></tr>;
            })}</tbody></table></div>}
        </Section>
        <Section title="Followed-wallet activity in this market" pad={false}><ActivityTable rows={data.activity} /></Section>
      </div>
      <div className="tiny faint" style={{ marginTop: 12 }}>{pct(r?.dataQuality?.coverage) && `Coverage ${pct(r?.dataQuality?.coverage)} of followed wallets refreshed.`} Consensus here uses minimum support 1 so every holder is visible.</div>
    </div>
  );
}
