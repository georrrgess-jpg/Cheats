import { describe, it, expect } from 'vitest';
import { computeConsensus, capShares } from '../server/src/core/consensus.js';
import { S, NOW, wallet, pos, addr, mkMarket } from './helpers.js';

const run = (wallets: any[], positions: any[], extra: any = {}) =>
  computeConsensus({ now: NOW, settings: extra.settings ?? S(), wallets, positions, markets: extra.markets ?? new Map(), quotes: extra.quotes ?? new Map(), flows: extra.flows ?? [], changes: extra.changes ?? [], windowSec: 86400 });

describe('consensus: current agreement', () => {
  it('counts each wallet once regardless of how many trades it made', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000)], {
      flows: Array.from({ length: 20 }, (_, k) => ({ wallet: addr(1), tokenId: 'c1_yes', conditionId: 'c1', type: 'TRADE', side: 'BUY', usdcSize: 10, size: 20, ts: NOW - k })),
    });
    expect(r.results).toHaveLength(1);
    expect(r.results[0].supportCount).toBe(2);
  });

  it('a full exit removes support; a partial exit keeps support with smaller exposure', () => {
    const before = run([wallet(1), wallet(2), wallet(3)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000), pos(3, 'c1_yes', 1000)]);
    expect(before.results[0].supportCount).toBe(3);
    // wallet 3 fully exited (position gone), wallet 2 partially exited
    const after = run([wallet(1), wallet(2), wallet(3)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 400)], {
      changes: [{ wallet: addr(3), tokenId: 'c1_yes', ts: NOW - 60, prevSize: 1000, newSize: 0, isBaseline: false }, { wallet: addr(2), tokenId: 'c1_yes', ts: NOW - 60, prevSize: 1000, newSize: 400, isBaseline: false }],
    });
    const r = after.results[0];
    expect(r.supportCount).toBe(2);
    expect(r.supporters.find((u) => u.id === addr(2))!.netShares).toBe(400);
    expect(r.flows.exitedUnits).toContain(addr(3));
    expect(r.flows.reducingUnits).toEqual(expect.arrayContaining([addr(2), addr(3)]));
  });

  it('exit below minimum support yields no result', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000)]);
    expect(r.results).toHaveLength(0);
  });

  it('opposing outcomes on the same binary market are listed as opposition', () => {
    const r = run([wallet(1), wallet(2), wallet(3)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000), pos(3, 'c1_no', 1000)]);
    const yes = r.results.find((x) => x.tokenId === 'c1_yes')!;
    expect(yes.supportCount).toBe(2);
    expect(yes.opposeCount).toBe(1);
    expect(yes.opposers[0].id).toBe(addr(3));
  });

  it('holding both sides nets out (YES+NO pair is not directional)', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(1, 'c1_no', 1000), pos(2, 'c1_yes', 1000)]);
    expect(r.results).toHaveLength(0); // wallet 1 has zero net exposure, so only one supporter
    const r2 = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(1, 'c1_no', 300), pos(2, 'c1_yes', 1000)]);
    expect(r2.results[0].supporters.find((u) => u.id === addr(1))!.netShares).toBe(700);
  });

  it('multi-outcome events: other outcomes are listed separately, not counted as opposition', () => {
    const markets = new Map([['a', mkMarket({ conditionId: 'a', tokenIds: ['a_yes', 'a_no'], negRisk: true, eventId: 'ev' })], ['b', mkMarket({ conditionId: 'b', tokenIds: ['b_yes', 'b_no'], negRisk: true, eventId: 'ev' })]]);
    const r = run([wallet(1), wallet(2), wallet(3)], [pos(1, 'a_yes', 1000, { eventId: 'ev' }), pos(2, 'a_yes', 1000, { eventId: 'ev' }), pos(3, 'b_yes', 1000, { eventId: 'ev' })], { markets });
    const a = r.results.find((x) => x.tokenId === 'a_yes')!;
    expect(a.opposeCount).toBe(0);
    expect(a.otherOutcomeHolders.map((o) => o.tokenId)).toContain('b_yes');
  });

  it('stale wallets are excluded from support and from the denominator, and listed', () => {
    const r = run([wallet(1), wallet(2), wallet(3, { positionsSyncedAt: NOW - 99999 })], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000), pos(3, 'c1_yes', 1000)]);
    const x = r.results[0];
    expect(x.supportCount).toBe(2);
    expect(x.eligibleWallets).toBe(2);
    expect(x.followedWallets).toBe(3);
    expect(x.staleHolders.map((h) => h.address)).toEqual([addr(3)]);
    expect(x.dataQuality.issues.join(' ')).toMatch(/not refreshed/);
  });

  it('never-synced wallets count as stale (missing history is not zero exposure)', () => {
    const r = run([wallet(1), wallet(2), wallet(3, { positionsSyncedAt: null })], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000)]);
    expect(r.staleWallets).toEqual([addr(3)]);
  });

  it('resolved / redeemable positions and closed markets do not count', () => {
    const markets = new Map([['c2', mkMarket({ conditionId: 'c2', tokenIds: ['c2_yes', 'c2_no'], closed: true })]]);
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000, { redeemable: true }), pos(2, 'c1_yes', 1000), pos(1, 'c2_yes', 1000), pos(2, 'c2_yes', 1000)], { markets });
    expect(r.results).toHaveLength(0);
  });

  it('dust below minPositionUsd is ignored', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 10)]);
    expect(r.results).toHaveLength(0);
  });

  it('declared clusters count once', () => {
    const r = run([wallet(1, { cluster: 'same' }), wallet(2, { cluster: 'same' }), wallet(3)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000), pos(3, 'c1_yes', 1000)]);
    expect(r.results[0].supportCount).toBe(2);
    expect(r.results[0].supporters.some((u) => u.kind === 'cluster' && u.wallets.length === 2)).toBe(true);
  });

  it('suspected links (near-identical holdings) are collapsed and flagged when configured', () => {
    const toks = ['c1_yes', 'c2_yes', 'c3_yes', 'c4_yes', 'c5_yes'];
    const ps = [1, 2].flatMap((w) => toks.map((t) => pos(w, t, 1000)));
    ps.push(pos(3, 'c1_yes', 1000));
    const r = run([wallet(1), wallet(2), wallet(3)], ps);
    expect(r.suspectedLinks).toHaveLength(1);
    const c1 = r.results.find((x) => x.tokenId === 'c1_yes')!;
    expect(c1.supportCount).toBe(2);
    expect(c1.flags.join(' ')).toMatch(/Suspected linked/);
    const s = S(); s.consensus.collapseSuspectedLinks = false;
    const r2 = run([wallet(1), wallet(2), wallet(3)], ps, { settings: s });
    expect(r2.results.find((x) => x.tokenId === 'c1_yes')!.supportCount).toBe(3);
  });

  it('influence cap limits one whale\'s exposure share', () => {
    const r = run([wallet(1), wallet(2), wallet(3), wallet(4)], [pos(1, 'c1_yes', 1_000_000), pos(2, 'c1_no', 1000), pos(3, 'c1_no', 1000), pos(4, 'c1_no', 1000)]);
    const no = r.results.find((x) => x.tokenId === 'c1_no')!;
    const whale = no.opposers[0];
    expect(whale.exposureShare).toBeCloseTo(0.35, 6);
    expect(no.score.components.exposure).toBeCloseTo(0.65, 6); // uncapped it would be ~0.003
  });

  it('flows: buying the complement is an outflow, merges are not directional, backfill is never "live"', () => {
    const flows = [
      { wallet: addr(1), tokenId: 'c1_yes', conditionId: 'c1', type: 'TRADE', side: 'BUY', usdcSize: 100, size: 200, ts: NOW - 100 },
      { wallet: addr(2), tokenId: 'c1_no', conditionId: 'c1', type: 'TRADE', side: 'BUY', usdcSize: 40, size: 80, ts: NOW - 100, isBackfill: true },
      { wallet: addr(2), tokenId: null, conditionId: 'c1', type: 'MERGE', side: null, usdcSize: 500, size: 500, ts: NOW - 100 },
    ];
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000)], { flows });
    const x = r.results[0];
    expect(x.flows.inflowUsd).toBe(100);
    expect(x.flows.outflowUsd).toBe(40);
    expect(x.flows.reducingUnits).toContain(addr(2));
    expect(x.flows.liveReducingUnits).not.toContain(addr(2));
    expect(x.flows.backfillIncluded).toBe(true);
  });

  it('missing quote => executable price unavailable (null), not zero', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000)]);
    expect(r.results[0].quote).toBeNull();
    expect(r.results[0].dataQuality.grade).not.toBe('High');
  });

  it('unknown entry price is reported as partial coverage, not as 0', () => {
    const r = run([wallet(1), wallet(2)], [pos(1, 'c1_yes', 1000, { avgPrice: null }), pos(2, 'c1_yes', 1000, { avgPrice: 0.4 })]);
    expect(r.results[0].entry.weightedAvgPrice).toBeCloseTo(0.4);
    expect(r.results[0].entry.coverage).toBeCloseTo(0.5);
  });

  it('is deterministic', () => {
    const args = [[wallet(1), wallet(2), wallet(3)], [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 500), pos(3, 'c1_no', 700)]] as [any[], any[]];
    expect(JSON.stringify(run(...args))).toBe(JSON.stringify(run(...args)));
  });
});

describe('capShares', () => {
  it('caps and redistributes, preserving the total', () => {
    const s = capShares([100, 1, 1, 1], 0.4);
    expect(s[0]).toBeCloseTo(0.4);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(s[1]).toBeCloseTo(0.2);
  });
  it('falls back to equal weights when the cap is infeasible', () => {
    expect(capShares([10, 1], 0.35)).toEqual([0.5, 0.5]);
  });
});
