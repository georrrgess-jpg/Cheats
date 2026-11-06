import { describe, it, expect } from 'vitest';
import { freshDb, addr, act, FixtureProvider, mkBook, mkMarket, mkPosition } from './helpers.js';
import { Worker } from '../server/src/worker/scheduler.js';
import { getActiveSettings } from '../server/src/settings.js';

function setup() {
  const db = freshDb(); const p = new FixtureProvider();
  const now = Math.floor(Date.now() / 1000);
  p.markets.set('c1', mkMarket({ conditionId: 'c1', tokenIds: ['c1_yes', 'c1_no'] }));
  p.books.set('c1_yes', mkBook('c1_yes', 0.5, 0.52, 5000, now));
  p.books.set('c1_no', mkBook('c1_no', 0.48, 0.5, 5000, now));
  for (let i = 1; i <= 4; i++) {
    db.prepare("INSERT INTO wallets(address,label,source,followed,added_at) VALUES(?,?,'manual',1,?)").run(addr(i), `W${i}`, now - 86400);
    p.open.set(addr(i), []); p.closed.set(addr(i), []);
    p.activity.set(addr(i), [act(i, now - 7200, { conditionId: 'c1', tokenId: 'c1_yes' })]);
  }
  const hold = (i: number, size: number) => p.open.set(addr(i), size ? [mkPosition({ wallet: addr(i), tokenId: 'c1_yes', conditionId: 'c1', oppositeTokenId: 'c1_no', size, currentPrice: 0.51 })] : []);
  return { db, p, now, hold };
}
const alerts = (db: any) => (db.prepare('SELECT kind FROM alerts').all() as any[]).map((r) => r.kind);

describe('worker end-to-end (fixture provider)', () => {
  it('baseline -> new convergence alert -> restart without duplicates -> exits end the signal', async () => {
    const { db, p, now, hold } = setup();
    hold(1, 1000); hold(2, 1000);
    const w = new Worker(db, p, null);
    await w.tick(now);
    expect(db.prepare('SELECT COUNT(*) n FROM signals').get()).toEqual({ n: 1 });
    expect(alerts(db)).toEqual([]);                                   // baseline, no alerts

    hold(3, 1000);                                                     // a third wallet buys in
    (w as any).nextPositions.clear();
    await w.tick(now + 200);
    expect(alerts(db)).toContain('convergence');

    const w2 = new Worker(db, p, null);                                // process restart, same DB
    await w2.tick(now + 400);
    expect(alerts(db).filter((k) => k === 'convergence')).toHaveLength(1);
    expect((db.prepare('SELECT support FROM signals WHERE ended_at IS NULL').get() as any).support).toBe(3);

    hold(2, 0); hold(3, 0);                                            // two supporters exit
    (w2 as any).nextPositions.clear();
    await w2.tick(now + 600);
    expect((db.prepare('SELECT state FROM signals ORDER BY id DESC LIMIT 1').get() as any).state).toBe('Ended');
    expect(alerts(db)).toContain('exit');
  });

  it('provider outage: stored data is kept, failures recorded, no fake data substituted', async () => {
    const { db, p, now, hold } = setup();
    hold(1, 1000); hold(2, 1000);
    const w = new Worker(db, p, null);
    await w.tick(now);
    p.fail.add('getOpenPositions'); p.fail.add('getActivity'); p.fail.add('getOrderBooks');
    (w as any).nextPositions.clear(); (w as any).nextActivity.clear();
    await w.tick(now + 200);
    const st = db.prepare('SELECT SUM(positions_failures) f FROM wallet_sync').get() as any;
    expect(st.f).toBe(4);
    expect(db.prepare('SELECT COUNT(*) n FROM positions').get()).toEqual({ n: 2 });
    // once the stale threshold passes, those wallets drop out of consensus instead of being counted on old data
    const S = getActiveSettings(db).settings;
    await w.tick(now + S.tracking.staleAfterSec + 300);
    expect((db.prepare('SELECT state FROM signals ORDER BY id DESC LIMIT 1').get() as any).state).toBe('Ended');
    expect(alerts(db)).toContain('stale');
  });
});
