import { describe, it, expect } from 'vitest';
import { freshDb, NOW, FixtureProvider, mkBook, mkMarket } from './helpers.js';
import { simulateFill, placeOrder, processPendingOrders, ensureDefaultAccount, holdings, settleResolved, feeFor } from '../server/src/core/paper.js';
import { storeMarkets } from '../server/src/worker/marketSync.js';
import { storeBooks } from '../server/src/worker/quoteSync.js';
import { updateSettings } from '../server/src/settings.js';

describe('fill simulation', () => {
  const asks = [{ price: 0.5, size: 100 }, { price: 0.52, size: 100 }, { price: 0.6, size: 1000 }];
  it('walks the book, applies fees p(1-p) and extra slippage', () => {
    const r = simulateFill({ side: 'BUY', levels: asks, usd: 40, limitPrice: 0.55, feeRate: 0.04, feeExponent: 1, extraBps: 0 });
    expect(r.status).toBe('filled');
    expect(r.notional + r.fees).toBeCloseTo(40, 6);
    expect(r.fees).toBeCloseTo(r.shares * 0.04 * 0.25, 1);
  });
  it('partial fill when depth within the limit runs out (no unlimited liquidity)', () => {
    const r = simulateFill({ side: 'BUY', levels: asks, usd: 1000, limitPrice: 0.55, feeRate: 0, feeExponent: 1, extraBps: 0 });
    expect(r.status).toBe('partial');
    expect(r.shares).toBe(200);
    expect(r.note).toMatch(/exhausted/);
  });
  it('unfilled when the book is empty or entirely beyond the limit', () => {
    expect(simulateFill({ side: 'BUY', levels: [], usd: 10, limitPrice: 1, feeRate: 0, feeExponent: 1, extraBps: 0 }).status).toBe('unfilled');
    expect(simulateFill({ side: 'BUY', levels: asks, usd: 10, limitPrice: 0.4, feeRate: 0, feeExponent: 1, extraBps: 0 }).status).toBe('unfilled');
  });
  it('unknown market fee falls back to a disclosed category default', () => {
    expect(feeFor(null)).toEqual({ rate: 0.05, exponent: 1, estimated: true });
    expect(feeFor(mkMarket({ conditionId: 'c', tokenIds: [], feeRate: 0 })).rate).toBe(0);
  });
});

describe('paper orders: no look-ahead', () => {
  it('never fills from a quote cached before the decision; waits for a book fetched after latency', async () => {
    const db = freshDb(); const p = new FixtureProvider();
    const acct = ensureDefaultAccount(db);
    storeMarkets(db, [mkMarket({ conditionId: 'c1', tokenIds: ['t1', 't2'] })], NOW);
    storeBooks(db, [mkBook('t1', 0.1, 0.11, 100000, NOW - 600)]);        // stale cheap quote cached earlier
    const now = Math.floor(Date.now() / 1000);
    p.books.set('t1', mkBook('t1', 0.6, 0.62, 100000, now));            // the market has moved since
    // decision made just now: too early to fill (simulated latency not elapsed)
    const early = placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't1', conditionId: 'c1', usd: 100, origin: 'manual' }, now);
    // decision made 5 s ago: fillable, but only against a book fetched now (after the decision)
    const id = placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't1', conditionId: 'c1', usd: 100, origin: 'manual' }, now - 5);
    await processPendingOrders(db, p, now);
    expect((db.prepare('SELECT status FROM paper_orders WHERE id=?').get(early) as any).status).toBe('pending');
    const o = db.prepare('SELECT * FROM paper_orders WHERE id=?').get(id) as any;
    expect(o.status).toBe('filled');
    expect(o.avg_price).toBeGreaterThanOrEqual(0.62);                    // filled at the fresh ask, not the cached 0.11
    expect(o.quote_fetched_at).toBeGreaterThanOrEqual(o.created_at + 2);
    expect(o.settings_version).toBeTruthy();
  });

  it('filling is idempotent: a second processor cannot double-fill or double-debit cash', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const acct = ensureDefaultAccount(db);
    const now = Math.floor(Date.now() / 1000);
    storeMarkets(db, [mkMarket({ conditionId: 'c1', tokenIds: ['t1', 't2'] })], now);
    p.books.set('t1', mkBook('t1', 0.5, 0.5, 100000, now));
    placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't1', conditionId: 'c1', usd: 100, origin: 'manual' }, now - 10);
    await Promise.all([processPendingOrders(db, p, now), processPendingOrders(db, p, now)]);
    const cash = (db.prepare('SELECT cash FROM paper_accounts').get() as any).cash;
    expect(cash).toBeCloseTo(9900, 6);
  });

  it('records the settings version in force; later changes do not rewrite history', async () => {
    const db = freshDb();
    const acct = ensureDefaultAccount(db);
    const id1 = placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't', conditionId: 'c', usd: 10, origin: 'manual' }, NOW);
    updateSettings(db, { paper: { defaultOrderUsd: 999 } }, 'test');
    const id2 = placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't', conditionId: 'c', usd: 10, origin: 'manual' }, NOW);
    const v = (id: number) => (db.prepare('SELECT settings_version v FROM paper_orders WHERE id=?').get(id) as any).v;
    expect(v(id2)).toBe(v(id1) + 1);
  });

  it('rejects buys beyond virtual cash and sells without a position', () => {
    const db = freshDb(); const acct = ensureDefaultAccount(db);
    expect(() => placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't', conditionId: 'c', usd: 1e9, origin: 'manual' }, NOW)).toThrow(/cash/);
    expect(() => placeOrder(db, { accountId: acct, side: 'SELL', tokenId: 't', conditionId: 'c', origin: 'manual' }, NOW)).toThrow(/No paper position/);
  });

  it('settles only on unambiguous resolution', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const acct = ensureDefaultAccount(db);
    const now = Math.floor(Date.now() / 1000);
    storeMarkets(db, [mkMarket({ conditionId: 'c1', tokenIds: ['t1', 't2'] })], now);
    p.books.set('t1', mkBook('t1', 0.5, 0.5, 100000, now));
    placeOrder(db, { accountId: acct, side: 'BUY', tokenId: 't1', conditionId: 'c1', usd: 100, origin: 'manual' }, now - 10);
    await processPendingOrders(db, p, now);
    storeMarkets(db, [mkMarket({ conditionId: 'c1', tokenIds: ['t1', 't2'], closed: true, outcomePrices: [0.5, 0.5] })], now);
    expect(settleResolved(db, now)).toBe(0);                             // closed but payout ambiguous
    storeMarkets(db, [mkMarket({ conditionId: 'c1', tokenIds: ['t1', 't2'], closed: true, outcomePrices: [1, 0] })], now);
    expect(settleResolved(db, now)).toBe(1);
    expect(holdings(db, acct)[0].shares).toBeCloseTo(0);
    const cash = (db.prepare('SELECT cash FROM paper_accounts').get() as any).cash;
    expect(cash).toBeGreaterThan(10000);                                 // bought ~0.5, paid 1.0
  });
});
