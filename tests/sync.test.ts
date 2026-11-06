import { describe, it, expect, vi } from 'vitest';
import { freshDb, S, NOW, addr, act, FixtureProvider, mkPosition } from './helpers.js';
import { syncWalletActivity, activityKeys } from '../server/src/worker/activitySync.js';
import { syncWalletPositions, applyPositions } from '../server/src/worker/positionSync.js';
import { HttpClient, HttpError } from '../server/src/util/http.js';

const W = addr(1);
const count = (db: any, t: string, where = '1') => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`).get() as any).n;

describe('activity sync', () => {
  it('deduplicates repeated fetches and overlapping cursors', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.activity.set(W, [act(1, NOW - 3000), act(1, NOW - 2000), act(1, NOW - 1000)]);
    await syncWalletActivity(db, p, W, s, NOW);
    await syncWalletActivity(db, p, W, s, NOW + 60); // cursor is inclusive -> refetches the last row
    await syncWalletActivity(db, p, W, s, NOW + 120);
    expect(count(db, 'activity')).toBe(3);
  });

  it('keeps genuinely identical fills in one transaction as separate rows (ordinal keys)', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    const twin = act(1, NOW - 500, { txHash: '0xsame' });
    p.activity.set(W, [twin, { ...twin }]);
    await syncWalletActivity(db, p, W, s, NOW);
    await syncWalletActivity(db, p, W, s, NOW + 60);
    expect(count(db, 'activity')).toBe(2);
    expect(new Set(activityKeys([twin, { ...twin }])).size).toBe(2);
  });

  it('initial load and downtime recovery are stored as history (no alerts); prompt observations are live', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.activity.set(W, [act(1, NOW - 86400 * 2)]);
    await syncWalletActivity(db, p, W, s, NOW);                               // initial backfill
    expect(count(db, 'activity', 'is_backfill=1')).toBe(1);
    p.activity.get(W)!.push(act(1, NOW + 30));                               // happens while running
    await syncWalletActivity(db, p, W, s, NOW + 60);
    expect(count(db, 'activity', 'is_backfill=0')).toBe(1);
    // process down for 3 hours; trades during downtime are observed late => history
    p.activity.get(W)!.push(act(1, NOW + 600), act(1, NOW + 3600));
    await syncWalletActivity(db, p, W, s, NOW + 3 * 3600);
    expect(count(db, 'activity', 'is_backfill=0')).toBe(1);
    expect(count(db, 'activity')).toBe(4);
  });

  it('restart recovery: a new process resumes from the stored cursor and backfills the gap', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.activity.set(W, [act(1, NOW - 100)]);
    await syncWalletActivity(db, p, W, s, NOW);
    p.activity.get(W)!.push(act(1, NOW + 1000), act(1, NOW + 2000));
    const p2 = new FixtureProvider(); p2.activity = p.activity;              // "restarted" provider, same DB
    const r = await syncWalletActivity(db, p2, W, s, NOW + 5000);
    expect(r.inserted).toBe(2);
    expect((db.prepare('SELECT activity_cursor_ts c FROM wallet_sync').get() as any).c).toBe(NOW + 2000);
  });

  it('initial load is newest-first and records truncated coverage honestly', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S(); s.tracking.maxBackfillItems = 2;
    p.activity.set(W, [act(1, NOW - 4000), act(1, NOW - 3000), act(1, NOW - 2000), act(1, NOW - 1000)]);
    await syncWalletActivity(db, p, W, s, NOW);
    const st = db.prepare('SELECT * FROM wallet_sync').get() as any;
    expect(count(db, 'activity')).toBe(2);
    expect((db.prepare('SELECT MIN(ts) m FROM activity').get() as any).m).toBe(NOW - 2000);
    expect(st.backfill_truncated).toBe(1);
    expect(st.backfill_from).toBe(NOW - 2000);
  });

  it('provider failure records the error, keeps stored data, and does not advance the cursor', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.activity.set(W, [act(1, NOW - 100)]);
    await syncWalletActivity(db, p, W, s, NOW);
    p.fail.add('getActivity');
    await expect(syncWalletActivity(db, p, W, s, NOW + 60)).rejects.toThrow();
    const st = db.prepare('SELECT * FROM wallet_sync').get() as any;
    expect(st.activity_failures).toBe(1);
    expect(st.activity_cursor_ts).toBe(NOW - 100);
    expect(count(db, 'activity')).toBe(1);
  });
});

describe('position reconciliation', () => {
  it('replaces holdings atomically, logs partial and full exits, flags first sync as baseline', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.open.set(W, [mkPosition({ wallet: W, tokenId: 'a', conditionId: 'ca', size: 100 }), mkPosition({ wallet: W, tokenId: 'b', conditionId: 'cb', size: 50 })]);
    await syncWalletPositions(db, p, W, s, NOW);
    expect(count(db, 'position_changes', 'is_baseline=1')).toBe(2);
    p.open.set(W, [mkPosition({ wallet: W, tokenId: 'a', conditionId: 'ca', size: 40 })]); // partial exit of a, full exit of b
    await syncWalletPositions(db, p, W, s, NOW + 180);
    expect(count(db, 'positions')).toBe(1);
    const ch = db.prepare('SELECT token_id, prev_size, new_size, is_baseline FROM position_changes WHERE is_baseline=0 ORDER BY token_id').all() as any[];
    expect(ch).toEqual([{ token_id: 'a', prev_size: 100, new_size: 40, is_baseline: 0 }, { token_id: 'b', prev_size: 50, new_size: 0, is_baseline: 0 }]);
  });

  it('changes observed after a long gap are baseline (not alerted as live)', () => {
    const db = freshDb(); const s = S();
    applyPositions(db, W, [mkPosition({ wallet: W, tokenId: 'a', conditionId: 'ca', size: 100 })], false, null, s, NOW);
    applyPositions(db, W, [], false, NOW, s, NOW + 10 * 3600);
    expect(count(db, 'position_changes', 'is_baseline=0')).toBe(0);
  });

  it('a failed sync keeps the previous holdings and marks failure (wallet later becomes stale)', async () => {
    const db = freshDb(); const p = new FixtureProvider(); const s = S();
    p.open.set(W, [mkPosition({ wallet: W, tokenId: 'a', conditionId: 'ca', size: 100 })]);
    await syncWalletPositions(db, p, W, s, NOW);
    p.fail.add('getOpenPositions');
    await expect(syncWalletPositions(db, p, W, s, NOW + 180)).rejects.toThrow();
    expect(count(db, 'positions')).toBe(1);
    const st = db.prepare('SELECT positions_synced_at, positions_failures FROM wallet_sync').get() as any;
    expect(st).toEqual({ positions_synced_at: NOW, positions_failures: 1 });
  });
});

describe('HTTP client', () => {
  const res = (status: number, body: any, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, { error: 'busy' }, { 'retry-after': '0.01' })).mockResolvedValueOnce(res(200, { ok: 1 }));
    const c = new HttpClient({ requestsPerSecond: 1000, fetchFn: f as any, baseDelayMs: 1 });
    expect(await c.request('https://x.test/a')).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.health.get('x.test')!.rateLimited).toBe(1);
  });
  it('retries 5xx and network errors with backoff, records failure after max retries', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const c = new HttpClient({ requestsPerSecond: 1000, fetchFn: f as any, baseDelayMs: 1, maxRetries: 2 });
    await expect(c.request('https://x.test/a')).rejects.toThrow('ECONNRESET');
    expect(f).toHaveBeenCalledTimes(3);
    expect(c.health.get('x.test')!.consecutiveFailures).toBe(1);
  });
  it('does not retry 4xx', async () => {
    const f = vi.fn().mockResolvedValue(res(400, { error: 'bad' }));
    const c = new HttpClient({ requestsPerSecond: 1000, fetchFn: f as any, baseDelayMs: 1 });
    await expect(c.request('https://x.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('spaces requests to respect the self-imposed rate', async () => {
    const f = vi.fn().mockImplementation(async () => res(200, {}));
    const c = new HttpClient({ requestsPerSecond: 20, fetchFn: f as any });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4, 5].map(() => c.request('https://x.test/a')));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
  });
});
