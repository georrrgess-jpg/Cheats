/** Synthetic demo dataset. Only loaded with `npm run demo`, which uses a separate DEMO database file. */
import type { DB } from './db.js';
import { FixtureProvider, mkBook, mkMarket, mkPosition } from './providers/fixture.js';
import { nowSec, DAY } from './util/time.js';
import { snapshotWatchlist } from './settings.js';

export function seedDemo(db: DB): FixtureProvider {
  const f = new FixtureProvider();
  const now = nowSec();
  const W = Array.from({ length: 8 }, (_, i) => `0xdemo${String(i).padStart(2, '0')}${'0'.repeat(32)}`.slice(0, 42));
  const names = ['Demo Alpha', 'Demo Bravo', 'Demo Charlie', 'Demo Delta', 'Demo Echo', 'Demo Foxtrot', 'Demo Golf', 'Demo Hotel'];
  const mk = [
    { c: '0xdemo_m1', t: ['demo_m1_yes', 'demo_m1_no'], q: '[DEMO] Will the Fed cut rates in December?', cat: 'Economics', bid: 0.61, ask: 0.63 },
    { c: '0xdemo_m2', t: ['demo_m2_yes', 'demo_m2_no'], q: '[DEMO] Will Candidate A win the governor race?', cat: 'Politics', bid: 0.42, ask: 0.45 },
    { c: '0xdemo_m3', t: ['demo_m3_yes', 'demo_m3_no'], q: '[DEMO] Will BTC close above $120k on Dec 31?', cat: 'Crypto', bid: 0.18, ask: 0.2 },
  ];
  for (const m of mk) {
    f.markets.set(m.c, mkMarket({ conditionId: m.c, tokenIds: m.t, question: m.q, category: m.cat, tags: [m.cat], eventSlug: m.c, slug: m.c, url: null, outcomePrices: [m.bid, 1 - m.bid] }));
    f.books.set(m.t[0], mkBook(m.t[0], m.bid, m.ask, 2000));
    f.books.set(m.t[1], mkBook(m.t[1], +(1 - m.ask).toFixed(2), +(1 - m.bid).toFixed(2), 2000));
  }
  const hold = (wi: number, mi: number, side: 0 | 1, size: number, avg: number) => {
    const m = mk[mi];
    const p = mkPosition({ wallet: W[wi], tokenId: m.t[side], conditionId: m.c, size, avgPrice: avg, outcome: side ? 'No' : 'Yes', outcomeIndex: side, oppositeTokenId: m.t[1 - side],
      currentPrice: side ? 1 - m.bid : m.bid, title: m.q, eventId: m.c, eventSlug: m.c, slug: m.c, firstEntryAt: now - (5 + wi) * DAY });
    f.open.set(W[wi], [...(f.open.get(W[wi]) || []), p]);
    f.activity.set(W[wi], [...(f.activity.get(W[wi]) || []), { wallet: W[wi], ts: now - (wi + 1) * 3600, type: 'TRADE', rawType: 'TRADE', conditionId: m.c, tokenId: m.t[side], outcome: p.outcome, outcomeIndex: side, side: 'BUY', size, usdcSize: size * avg, price: avg, txHash: `0xdemo_tx_${wi}_${mi}`, title: m.q, slug: m.c, eventSlug: m.c }]);
  };
  [0, 1, 2, 3, 4].forEach((w) => hold(w, 0, 0, 800 + w * 300, 0.52 + w * 0.01));
  hold(5, 0, 1, 900, 0.4);
  [1, 3, 6].forEach((w) => hold(w, 1, 1, 1500, 0.5));
  hold(7, 1, 0, 700, 0.44);
  [2, 7].forEach((w) => hold(w, 2, 0, 3000, 0.15));
  W.forEach((w, i) => {
    const closed = Array.from({ length: 30 + i * 10 }, (_, k) => mkPosition({ wallet: w, tokenId: `demo_c_${i}_${k}`, conditionId: `0xdemo_c_${i}_${k}`, size: 0, status: 'CLOSED', totalBought: 500, avgPrice: 0.4,
      costBasis: 200, realizedPnl: k % 3 === 0 ? -80 : 60 + (k % 5) * 20, lastEventAt: now - k * 2 * DAY, title: `[DEMO] closed ${k}` }));
    f.closed.set(w, closed);
    f.series.set(w, Array.from({ length: 200 }, (_, d) => ({ ts: now - (200 - d) * DAY, positionPnl: d * (20 + i * 5) + Math.sin(d / 7) * 300, realizedPnl: null, makerRebate: null, volumeUsd: null, tradeCount: null })));
    f.stats.set(w, { marketsTraded: 120 + i * 10, biggestWin: 900, joinDate: now - 300 * DAY, allTimeRealizedPnl: 5000, allTimePositionPnl: 5000, makerRebate: 10, tradeCount: 2000, volumeUsd: 150000 });
    db.prepare("INSERT OR IGNORE INTO wallets(address,label,source,followed,added_at) VALUES(?,?,'manual',1,?)").run(w, names[i], now - 10 * DAY);
  });
  f.leaderboard = W.map((w, i) => ({ rank: i + 1, wallet: w, userName: names[i], xUsername: null, pnl: 50000 - i * 4000, volumeShares: 1e6 }));
  snapshotWatchlist(db, 'Demo seed');
  return f;
}
