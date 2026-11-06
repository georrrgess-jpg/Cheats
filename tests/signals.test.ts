import { describe, it, expect } from 'vitest';
import { freshDb, S, NOW, wallet, pos, addr } from './helpers.js';
import { computeConsensus } from '../server/src/core/consensus.js';
import { updateSignals, decideState } from '../server/src/core/signals.js';
import { emitAlert } from '../server/src/core/alerts.js';

const q = (t: number) => new Map([['c1_yes', { tokenId: 'c1_yes', bestBid: 0.5, bestAsk: 0.52, asks: [{ price: 0.52, size: 5000 }], bids: [{ price: 0.5, size: 5000 }], fetchedAt: t }]]);
const results = (n: number, t: number, extra: any = {}) => computeConsensus({ now: t, settings: S(), wallets: Array.from({ length: 6 }, (_, i) => wallet(i + 1, { positionsSyncedAt: t - 5 })),
  positions: Array.from({ length: n }, (_, i) => pos(i + 1, 'c1_yes', 1000)), markets: new Map(), quotes: q(t), flows: [], changes: extra.changes ?? [], windowSec: 86400 }).results;
const alerts = (db: any) => db.prepare('SELECT kind FROM alerts ORDER BY id').all().map((r: any) => r.kind);

describe('signal lifecycle & alerts', () => {
  it('baseline run creates signals without alerts and without "New agreement"', () => {
    const db = freshDb();
    const out = updateSignals(db, results(4, NOW), NOW, S(), 1, true);
    expect(alerts(db)).toEqual([]);
    expect(out[0].state).toBe('Stable');
  });

  it('new convergence after baseline alerts once; cooldown prevents repeats', () => {
    const db = freshDb();
    updateSignals(db, [], NOW, S(), 1, true);
    const o = updateSignals(db, results(3, NOW + 60), NOW + 60, S(), 1, false);
    expect(o[0].state).toBe('New agreement');
    expect(alerts(db)).toEqual(['convergence']);
    updateSignals(db, results(2, NOW + 120), NOW + 120, S(), 1, false);  // drops below 3
    updateSignals(db, results(3, NOW + 180), NOW + 180, S(), 1, false);  // re-crosses inside cooldown
    expect(alerts(db)).toEqual(['convergence']);
  });

  it('threshold crossing: a signal growing 2 -> 3 alerts; staying at 3 does not', () => {
    const db = freshDb();
    updateSignals(db, results(2, NOW), NOW, S(), 1, true);
    updateSignals(db, results(3, NOW + 60), NOW + 60, S(), 1, false);
    updateSignals(db, results(3, NOW + 120), NOW + 120, S(), 1, false);
    expect(alerts(db).filter((k: string) => k === 'convergence')).toHaveLength(1);
  });

  it('a watchlist addition does not masquerade as new agreement', () => {
    const db = freshDb();
    updateSignals(db, [], NOW, S(), 1, true);
    const o = updateSignals(db, results(3, NOW + 60), NOW + 60, S(), 1, false, new Set([addr(3)]));
    expect(o[0].state).not.toBe('New agreement');
    expect(alerts(db)).toEqual([]);
  });

  it('signal ends when support falls below minimum, with an exit alert if supporters exited live', () => {
    const db = freshDb();
    updateSignals(db, results(3, NOW), NOW, S(), 1, true);
    for (const w of [2, 3]) db.prepare('INSERT INTO position_changes(wallet,token_id,condition_id,ts,prev_size,new_size,price,is_baseline) VALUES(?,?,?,?,?,?,?,0)').run(addr(w), 'c1_yes', 'c1', NOW + 50, 1000, 0, 0.5);
    updateSignals(db, results(1, NOW + 60), NOW + 60, S(), 1, false);
    const sig = db.prepare('SELECT state, ended_at FROM signals').get() as any;
    expect(sig.state).toBe('Ended');
    expect(alerts(db)).toContain('exit');
  });

  it('Weakening when supporters fall vs lookback; Building when they rise', () => {
    const s = S();
    const r3 = results(3, NOW)[0];
    expect(decideState(r3, { firstDetectedAt: NOW - 86400 * 3, baseline: false }, { support: 5, supportValue: null, ts: NOW - 86400 }, NOW, s).state).toBe('Weakening');
    expect(decideState(r3, { firstDetectedAt: NOW - 86400 * 3, baseline: false }, { support: 2, supportValue: null, ts: NOW - 86400 }, NOW, s).state).toBe('Building');
    expect(decideState(r3, { firstDetectedAt: NOW - 86400 * 3, baseline: false }, { support: 3, supportValue: r3.supportValue, ts: NOW - 86400 }, NOW, s).state).toBe('Stable');
  });

  it('Stale when the quote is old, regardless of agreement', () => {
    const s = S();
    const r = computeConsensus({ now: NOW, settings: s, wallets: [wallet(1), wallet(2)], positions: [pos(1, 'c1_yes', 1000), pos(2, 'c1_yes', 1000)], markets: new Map(), quotes: q(NOW - 3600), flows: [], changes: [], windowSec: 86400 }).results[0];
    expect(decideState(r, { firstDetectedAt: NOW, baseline: false }, null, NOW, s).state).toBe('Stale');
  });

  it('emitAlert cooldown is per key', () => {
    const db = freshDb();
    expect(emitAlert(db, { now: NOW, kind: 'x', key: 'k1', severity: 'info', title: 't', body: 'b', cooldownSec: 100 })).toBe(true);
    expect(emitAlert(db, { now: NOW + 50, kind: 'x', key: 'k1', severity: 'info', title: 't', body: 'b', cooldownSec: 100 })).toBe(false);
    expect(emitAlert(db, { now: NOW + 50, kind: 'x', key: 'k2', severity: 'info', title: 't', body: 'b', cooldownSec: 100 })).toBe(true);
    expect(emitAlert(db, { now: NOW + 101, kind: 'x', key: 'k1', severity: 'info', title: 't', body: 'b', cooldownSec: 100 })).toBe(true);
  });
});
