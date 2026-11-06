/**
 * Paper trading. Forward-only: an order is recorded at decision time with the signal + settings snapshot, and is
 * filled ONLY against an order book fetched at least `simulatedLatencySec` AFTER the decision. Historical order
 * books are not available, so no backtest is offered and every fill is labelled an estimate.
 *
 * Fee model (Polymarket docs): fee = shares × feeRate × p × (1 − p), taker only. Unknown fee rate → category default.
 */
import type { DB } from '../db.js';
import type { MarketDataProvider, MarketInfo } from '../providers/types.js';
import { getActiveSettings, currentWatchlistVersion, type Settings } from '../settings.js';
import { getMarket, storeMarkets } from '../worker/marketSync.js';
import { storeBooks } from '../worker/quoteSync.js';

const CATEGORY_FEE: Record<string, number> = { Crypto: 0.07, Sports: 0.05, Finance: 0.04, Politics: 0.04, Economics: 0.05, Culture: 0.05, Weather: 0.05, Mentions: 0.04, Tech: 0.04, Geopolitics: 0, Other: 0.05 };

export function feeFor(m: MarketInfo | null): { rate: number; exponent: number; estimated: boolean } {
  if (m && m.feeRate !== null) return { rate: m.feeRate, exponent: m.feeExponent ?? 1, estimated: false };
  return { rate: CATEGORY_FEE[m?.category ?? 'Other'] ?? 0.05, exponent: 1, estimated: true };
}

export interface FillResult { status: 'filled' | 'partial' | 'unfilled'; shares: number; avgPrice: number | null; notional: number; fees: number; levels: number; note: string }

/**
 * Walk the book. BUY consumes asks up to `limitPrice` with budget `usd` (notional+fees). SELL consumes bids down to
 * `limitPrice` for `shares`. `extraBps` worsens every level's price to reflect latency/queue uncertainty.
 */
export function simulateFill(p: { side: 'BUY' | 'SELL'; levels: { price: number; size: number }[]; usd?: number; shares?: number; limitPrice: number; feeRate: number; feeExponent: number; extraBps: number }): FillResult {
  const fee1 = (px: number) => p.feeRate * Math.pow(px * (1 - px), p.feeExponent);
  let shares = 0, notional = 0, fees = 0, levels = 0;
  if (!p.levels.length) return { status: 'unfilled', shares: 0, avgPrice: null, notional: 0, fees: 0, levels: 0, note: 'No liquidity on this side of the book.' };
  if (p.side === 'BUY') {
    let budget = p.usd ?? 0;
    for (const l of p.levels) {
      if (l.price > p.limitPrice + 1e-12 || budget <= 1e-9) break;
      const px = Math.min(0.999, l.price * (1 + p.extraBps / 10000));
      const per = px + fee1(l.price);
      const take = Math.min(l.size, budget / per);
      if (take <= 0) break;
      shares += take; notional += take * px; fees += take * fee1(l.price); budget -= take * per; levels++;
    }
    const want = p.usd ?? 0;
    const spent = notional + fees;
    const status = shares <= 1e-9 ? 'unfilled' : spent >= want - 0.01 ? 'filled' : 'partial';
    return { status, shares, avgPrice: shares ? notional / shares : null, notional, fees, levels,
      note: status === 'unfilled' ? `No asks at or below limit ${p.limitPrice.toFixed(3)}.` : status === 'partial' ? `Book depth within limit ${p.limitPrice.toFixed(3)} exhausted: filled $${spent.toFixed(2)} of $${want.toFixed(2)}.` : `Filled across ${levels} level(s).` };
  }
  let rem = p.shares ?? 0;
  for (const l of p.levels) {
    if (l.price < p.limitPrice - 1e-12 || rem <= 1e-9) break;
    const px = Math.max(0.001, l.price * (1 - p.extraBps / 10000));
    const take = Math.min(l.size, rem);
    shares += take; notional += take * px; fees += take * fee1(l.price); rem -= take; levels++;
  }
  const status = shares <= 1e-9 ? 'unfilled' : rem <= 1e-6 ? 'filled' : 'partial';
  return { status, shares, avgPrice: shares ? notional / shares : null, notional, fees, levels,
    note: status === 'unfilled' ? `No bids at or above limit ${p.limitPrice.toFixed(3)}.` : status === 'partial' ? `Sold ${shares.toFixed(2)} of ${(p.shares ?? 0).toFixed(2)} shares within limit.` : `Filled across ${levels} level(s).` };
}

export function ensureDefaultAccount(db: DB) {
  const r = db.prepare('SELECT id FROM paper_accounts ORDER BY id LIMIT 1').get() as any;
  if (r) return r.id as number;
  return Number(db.prepare('INSERT INTO paper_accounts(name,created_at,starting_cash,cash) VALUES(?,?,?,?)').run('Main', Math.floor(Date.now() / 1000), 10000, 10000).lastInsertRowid);
}

export function holdings(db: DB, accountId: number) {
  const rows = db.prepare(`SELECT token_id, condition_id, MAX(outcome) outcome, MAX(title) title,
      SUM(CASE WHEN side='BUY' THEN filled_shares ELSE -filled_shares END) shares,
      SUM(CASE WHEN side='BUY' THEN notional+fees ELSE 0 END) buy_cost, SUM(CASE WHEN side='BUY' THEN filled_shares ELSE 0 END) buy_shares,
      SUM(CASE WHEN side='SELL' THEN notional-fees ELSE 0 END) sell_proceeds, SUM(CASE WHEN side='SELL' THEN filled_shares ELSE 0 END) sell_shares,
      MIN(CASE WHEN side='BUY' THEN signal_id END) signal_id, MAX(settings_version) settings_version
    FROM paper_orders WHERE account_id=? AND status IN ('filled','partial','settled') GROUP BY token_id, condition_id`).all(accountId) as any[];
  return rows.map((r) => {
    const avgCost = r.buy_shares > 0 ? r.buy_cost / r.buy_shares : null;
    const realized = avgCost !== null ? r.sell_proceeds - r.sell_shares * avgCost : 0;
    return { ...r, shares: Math.max(0, r.shares), avgCost, realized };
  });
}

export interface OrderRequest { accountId: number; side: 'BUY' | 'SELL'; tokenId: string; conditionId: string; usd?: number; shares?: number; origin: 'manual' | 'auto'; signalId?: number | null; signalSnapshot?: unknown; outcome?: string | null; title?: string | null }

export function placeOrder(db: DB, o: OrderRequest, now: number) {
  const { version, settings: S } = getActiveSettings(db);
  if (o.side === 'BUY' && !(o.usd && o.usd > 0)) throw new Error('Buy amount must be positive.');
  if (o.side === 'SELL') {
    const h = holdings(db, o.accountId).find((x) => x.token_id === o.tokenId);
    if (!h || h.shares <= 1e-9) throw new Error('No paper position to sell.');
    o.shares = Math.min(o.shares ?? h.shares, h.shares);
  }
  const acct = db.prepare('SELECT * FROM paper_accounts WHERE id=?').get(o.accountId) as any;
  if (!acct) throw new Error('Unknown account');
  if (o.side === 'BUY' && o.usd! > acct.cash + 1e-9) throw new Error(`Insufficient virtual cash ($${acct.cash.toFixed(2)}).`);
  const id = Number(db.prepare(`INSERT INTO paper_orders(account_id,created_at,side,token_id,condition_id,outcome,title,requested_usd,requested_shares,status,origin,signal_id,signal_snapshot,settings_version,watchlist_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.accountId, now, o.side, o.tokenId, o.conditionId, o.outcome ?? null, o.title ?? null, o.usd ?? null, o.shares ?? null, 'pending', o.origin, o.signalId ?? null,
      o.signalSnapshot === undefined ? null : JSON.stringify(o.signalSnapshot), version, currentWatchlistVersion(db)).lastInsertRowid);
  void S;
  return id;
}

/** Fill pending orders using a FRESH book fetched now (>= latency after decision). Never uses a cached quote. */
export async function processPendingOrders(db: DB, provider: MarketDataProvider, now: number) {
  const { settings: S } = getActiveSettings(db);
  const pending = db.prepare("SELECT * FROM paper_orders WHERE status='pending' AND created_at <= ?").all(now - S.paper.simulatedLatencySec) as any[];
  if (!pending.length) return 0;
  const toks = [...new Set(pending.map((o) => o.token_id))];
  let books: Awaited<ReturnType<MarketDataProvider['getOrderBooks']>> = [];
  try { books = await provider.getOrderBooks(toks); storeBooks(db, books); } catch { /* handled per order below */ }
  for (const o of pending) {
    const book = books.find((b) => b.tokenId === o.token_id);
    if (!book || book.fetchedAt < o.created_at + S.paper.simulatedLatencySec) {
      if (now - o.created_at > 600) db.prepare("UPDATE paper_orders SET status='unfilled', fill_note=?, filled_at=? WHERE id=?").run('No executable quote obtained within 10 minutes of the decision.', now, o.id);
      continue;
    }
    let m = getMarket(db, o.condition_id);
    if (!m) { try { const ms = await provider.getMarkets([o.condition_id]); storeMarkets(db, ms, now); m = ms[0] ?? null; } catch { /* fee estimated */ } }
    if (m?.closed) { db.prepare("UPDATE paper_orders SET status='unfilled', fill_note=?, filled_at=? WHERE id=?").run('Market closed for trading.', now, o.id); continue; }
    fillOrder(db, o, book, m, S, now);
  }
  return pending.length;
}

export function fillOrder(db: DB, o: any, book: { bids: any[]; asks: any[]; fetchedAt: number }, m: MarketInfo | null, S: Settings, now: number) {
  const fee = feeFor(m);
  const best = o.side === 'BUY' ? book.asks[0]?.price : book.bids[0]?.price;
  const limit = best === undefined ? 0 : o.side === 'BUY' ? Math.min(0.999, best * (1 + S.paper.maxSlippagePct)) : best * (1 - S.paper.maxSlippagePct);
  const cash = (db.prepare('SELECT cash FROM paper_accounts WHERE id=?').get(o.account_id) as any)?.cash ?? 0;
  const usd = o.side === 'BUY' ? Math.min(o.requested_usd ?? 0, Math.max(0, cash)) : undefined; // never spend more virtual cash than exists
  const r = simulateFill({ side: o.side, levels: o.side === 'BUY' ? book.asks : book.bids, usd, shares: o.requested_shares ?? undefined, limitPrice: limit, feeRate: fee.rate, feeExponent: fee.exponent, extraBps: S.paper.extraSlippageBps });
  const note = `${r.note} Estimated against live book fetched ${book.fetchedAt - o.created_at}s after decision; +${S.paper.extraSlippageBps}bps slippage; fee rate ${fee.rate}${fee.estimated ? ' (category default — market fee unknown)' : ''}.`;
  db.transaction(() => {
    // Idempotent: only a still-pending order can be filled (guards against two processors racing).
    const upd = db.prepare("UPDATE paper_orders SET status=?, filled_shares=?, avg_price=?, fees=?, notional=?, quote_fetched_at=?, filled_at=?, limit_price=?, fill_note=? WHERE id=? AND status='pending'")
      .run(r.status, r.shares, r.avgPrice, r.fees, r.notional, book.fetchedAt, now, limit, note, o.id);
    if (upd.changes === 1 && r.shares > 0) {
      const cashDelta = o.side === 'BUY' ? -(r.notional + r.fees) : r.notional - r.fees;
      db.prepare('UPDATE paper_accounts SET cash=cash+? WHERE id=?').run(cashDelta, o.account_id);
    }
  })();
  return r;
}

/** Settle paper holdings on resolved markets at the resolved payout (1 or 0). Only when payout is unambiguous. */
export function settleResolved(db: DB, now: number) {
  let n = 0;
  for (const a of db.prepare('SELECT id FROM paper_accounts').all() as any[]) {
    for (const h of holdings(db, a.id)) {
      if (h.shares <= 1e-9) continue;
      const m = getMarket(db, h.condition_id);
      if (!m || !m.closed) continue;
      const idx = m.tokenIds.indexOf(h.token_id);
      const px = idx >= 0 ? m.outcomePrices[idx] : null;
      if (px === null || !(px === 0 || px === 1)) continue;
      db.transaction(() => {
        db.prepare(`INSERT INTO paper_orders(account_id,created_at,side,token_id,condition_id,outcome,title,requested_shares,status,filled_shares,avg_price,fees,notional,filled_at,fill_note,is_estimate,origin)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id, now, 'SELL', h.token_id, h.condition_id, h.outcome, h.title, h.shares, 'settled', h.shares, px, 0, h.shares * px, now, `Market resolved; settled at ${px}.`, 0, 'settlement');
        db.prepare('UPDATE paper_accounts SET cash=cash+? WHERE id=?').run(h.shares * px, a.id);
      })();
      n++;
    }
  }
  return n;
}

/** Forward auto-rule: enter on qualifying signals, exit when the signal ends. Recorded with current versions. */
export function runAutoRule(db: DB, signals: { tokenId: string; signalId: number; state: string }[], results: Map<string, any>, now: number) {
  const { settings: S } = getActiveSettings(db);
  const R = S.paper.autoRule;
  if (!R.enabled) return 0;
  let placed = 0;
  for (const acct of db.prepare('SELECT * FROM paper_accounts WHERE auto_enabled=1').all() as any[]) {
    const hs = holdings(db, acct.id);
    const open = hs.filter((h) => h.shares > 1e-9);
    const pendingToks = new Set((db.prepare("SELECT token_id FROM paper_orders WHERE account_id=? AND status='pending'").all(acct.id) as any[]).map((r) => r.token_id));
    for (const s of signals) {
      const r = results.get(s.tokenId);
      if (!r || !R.states.includes(s.state) || r.score.total < R.minScore || r.supportCount < R.minSupport) continue;
      if (open.length >= R.maxOpen || pendingToks.has(s.tokenId)) continue;
      const already = db.prepare("SELECT 1 FROM paper_orders WHERE account_id=? AND signal_id=? AND origin='auto' AND side='BUY'").get(acct.id, s.signalId);
      if (already || open.some((h) => h.token_id === s.tokenId)) continue;
      if (acct.cash < R.orderUsd) continue;
      placeOrder(db, { accountId: acct.id, side: 'BUY', tokenId: s.tokenId, conditionId: r.conditionId, usd: R.orderUsd, origin: 'auto', signalId: s.signalId, signalSnapshot: snapshotOf(r, s.state), outcome: r.outcome, title: r.title }, now);
      pendingToks.add(s.tokenId); placed++;
    }
    if (R.exitOnEnd) {
      for (const h of open) {
        if (pendingToks.has(h.token_id)) continue;
        const autoBuy = db.prepare("SELECT signal_id FROM paper_orders WHERE account_id=? AND token_id=? AND origin='auto' AND side='BUY' ORDER BY id DESC LIMIT 1").get(acct.id, h.token_id) as any;
        if (!autoBuy?.signal_id) continue;
        const sig = db.prepare('SELECT ended_at FROM signals WHERE id=?').get(autoBuy.signal_id) as any;
        if (sig?.ended_at) { placeOrder(db, { accountId: acct.id, side: 'SELL', tokenId: h.token_id, conditionId: h.condition_id, origin: 'auto', signalId: autoBuy.signal_id, signalSnapshot: { reason: 'Signal ended' }, outcome: h.outcome, title: h.title }, now); placed++; }
      }
    }
  }
  return placed;
}

export function snapshotOf(r: any, state: string) {
  return {
    state, score: r.score, supportCount: r.supportCount, opposeCount: r.opposeCount, eligibleUnits: r.eligibleUnits, supportValue: r.supportValue,
    supporters: r.supporters.map((u: any) => ({ id: u.id, wallets: u.wallets.map((w: any) => w.address), value: u.value, avgPrice: u.avgPrice })),
    quote: r.quote ? { bid: r.quote.bid, ask: r.quote.ask, fetchedAt: r.quote.fetchedAt } : null, dataQuality: r.dataQuality,
  };
}
