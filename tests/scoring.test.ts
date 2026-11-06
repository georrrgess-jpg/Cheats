import { describe, it, expect } from 'vitest';
import { evaluateWallet } from '../server/src/core/scoring.js';
import { S, NOW, addr, mkPosition } from './helpers.js';

const W = addr(1);
const closed = (pnls: number[], daysApart = 2) => pnls.map((p, i) => mkPosition({ wallet: W, tokenId: `t${i}`, conditionId: `c${i}`, size: 0, status: 'CLOSED', realizedPnl: p, costBasis: 100, lastEventAt: NOW - i * daysApart * 86400 }));
const series = (days: number, f: (d: number) => number) => Array.from({ length: days }, (_, d) => ({ ts: NOW - (days - d) * 86400, positionPnl: f(d), realizedPnl: null, makerRebate: null, volumeUsd: null, tradeCount: null }));
const ev = (o: any) => evaluateWallet({ now: NOW, settings: S(), closed: { items: [], hasMore: false }, open: [], series: null, stats: null, categoryOf: () => 'Politics', lastActivityAt: NOW - 3600, ...o });

describe('wallet scoring', () => {
  it('counts resolved-but-unredeemed LOSERS (redeemable rows) in win rate', () => {
    const lost = mkPosition({ wallet: W, tokenId: 'L', conditionId: 'cL', size: 100, redeemable: true, status: 'REDEEMABLE', realizedPnl: 0, unrealizedPnl: -50, costBasis: 50 });
    const m = ev({ closed: { items: closed([10]), hasMore: false }, open: [lost] });
    expect(m.sample.resolved).toBe(2);
    expect(m.winRate).toBe(0.5);
  });

  it('flags a tiny sample and a single dominant win', () => {
    const m = ev({ closed: { items: closed([1000, 5, 5, -3]), hasMore: false } });
    const codes = m.flags.map((f) => f.code);
    expect(codes).toContain('SMALL_SAMPLE');
    expect(codes).toContain('ONE_BIG_WIN');
    expect(m.concentration.top1Share!).toBeGreaterThan(0.9);
  });

  it('marks unavailable components explicitly (scored 0) instead of inventing values', () => {
    const m = ev({ closed: { items: closed([5, 5]), hasMore: false }, series: null });
    expect(m.score.components.consistency.available).toBe(false);
    expect(m.score.components.consistency.detail).toMatch(/Unavailable/);
    expect(m.series.maxDrawdown).toBeNull();
    expect(m.flags.map((f) => f.code)).toContain('SHORT_HISTORY');
  });

  it('computes drawdown and monthly consistency from the PnL series', () => {
    const m = ev({ series: series(200, (d) => (d < 100 ? d * 10 : 1000 - (d - 100) * 3)) }); // peak 990, falls 297
    expect(m.series.maxDrawdown).toBeCloseTo(297, 0);
    expect(m.series.months).toBeGreaterThanOrEqual(6);
    expect(m.series.positiveMonths).toBeLessThan(m.series.months);
  });

  it('periods outside a truncated sample are Unavailable, not zero', () => {
    const m = ev({ closed: { items: closed(Array(31).fill(10), 1), hasMore: true } }); // covers exactly 30 days
    expect(m.realized.d30.available).toBe(true);
    expect(m.realized.d90.available).toBe(false);
    expect(m.realized.d90.pnl).toBeNull();
    expect(m.flags.map((f) => f.code)).toContain('TRUNCATED_SAMPLE');
  });

  it('a consistent, diversified, active wallet outscores a lucky one', () => {
    const good = ev({ closed: { items: closed(Array.from({ length: 150 }, (_, i) => (i % 3 === 0 ? -20 : 30))), hasMore: false }, series: series(365, (d) => d * 5), stats: { marketsTraded: 150, biggestWin: 30, joinDate: 0, allTimeRealizedPnl: 1, allTimePositionPnl: 1, makerRebate: 0, tradeCount: 500, volumeUsd: 1 } });
    const lucky = ev({ closed: { items: closed([5000, -10, -10, -10, -10]), hasMore: false }, series: series(40, (d) => (d > 30 ? 5000 : 0)) });
    expect(good.score.total).toBeGreaterThan(lucky.score.total + 20);
  });

  it('flags possible market making (uncertain wording)', () => {
    const m = ev({ stats: { marketsTraded: 10, biggestWin: 1, joinDate: 0, allTimeRealizedPnl: 100, allTimePositionPnl: 100, makerRebate: 80, tradeCount: 9000, volumeUsd: 1 } });
    const f = m.flags.find((x) => x.code === 'POSSIBLE_MARKET_MAKER')!;
    expect(f.text).toMatch(/uncertain/);
  });
});
