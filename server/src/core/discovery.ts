import type { DB } from '../db.js';
import type { MarketDataProvider } from '../providers/types.js';
import { getActiveSettings } from '../settings.js';
import { nowSec } from '../util/time.js';
import { evaluateWallet } from './scoring.js';
import { getMarkets, storeMarkets } from '../worker/marketSync.js';

export interface DiscoveryState { running: boolean; phase: string; done: number; total: number; startedAt: number | null; error: string | null }
export const discoveryState: DiscoveryState = { running: false, phase: 'idle', done: 0, total: 0, startedAt: null, error: null };

/** Evaluate one wallet and persist metrics. Fetches: closed positions, open positions, PnL series, stats, categories. */
export async function evaluateAndStore(db: DB, provider: MarketDataProvider, address: string) {
  const { version, settings: S } = getActiveSettings(db);
  const now = nowSec();
  const closed = await provider.getClosedPositions(address, { maxItems: S.scoring.closedSampleMax });
  const open = await provider.getOpenPositions(address, { maxItems: 3000 }).then((p) => p.items).catch(() => null);
  const series = await provider.getPnlSeries(address).catch(() => null);
  const stats = await provider.getUserStats(address).catch(() => null);
  // Categories for the 200 largest |PnL| resolved positions (they dominate the PnL mix); others count as Unclassified.
  const resolvedIds = [...closed.items, ...(open || []).filter((p) => p.redeemable)]
    .sort((a, b) => Math.abs(b.realizedPnl ?? 0) - Math.abs(a.realizedPnl ?? 0)).slice(0, 200).map((p) => p.conditionId.toLowerCase());
  const known = getMarkets(db, resolvedIds);
  const missing = resolvedIds.filter((c) => !known.has(c));
  if (missing.length) { try { storeMarkets(db, await provider.getMarkets(missing), now); } catch { /* categories become Unclassified */ } }
  const cats = getMarkets(db, resolvedIds);
  const lastAct = (db.prepare('SELECT MAX(ts) t FROM activity WHERE wallet=?').get(address) as any)?.t ?? null;
  const cand = db.prepare('SELECT boards FROM candidates WHERE address=?').get(address) as any;
  const m = evaluateWallet({ now, settings: S, closed, open, series, stats, lastActivityAt: lastAct, boards: cand ? JSON.parse(cand.boards) : [],
    categoryOf: (c) => cats.get(c.toLowerCase())?.category ?? null });
  db.prepare('INSERT INTO wallet_metrics(address,computed_at,json,settings_version) VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET computed_at=excluded.computed_at,json=excluded.json,settings_version=excluded.settings_version')
    .run(address, now, JSON.stringify(m), version);
  return m;
}

/** Pull public PnL leaderboards as a starting universe, then evaluate the top candidates on their own history. */
export async function runDiscovery(db: DB, provider: MarketDataProvider) {
  if (discoveryState.running) return;
  const { settings: S } = getActiveSettings(db);
  Object.assign(discoveryState, { running: true, phase: 'Reading leaderboards', done: 0, total: S.discovery.boards.length, startedAt: nowSec(), error: null });
  const runId = Number(db.prepare('INSERT INTO discovery_runs(started_at,boards) VALUES(?,?)').run(nowSec(), JSON.stringify(S.discovery.boards)).lastInsertRowid);
  try {
    const found = new Map<string, { userName: string | null; xUsername: string | null; boards: any[]; bestRank: number }>();
    for (const b of S.discovery.boards) {
      const rows = await provider.getLeaderboard({ period: b.period, category: b.category, limit: b.limit });
      for (const r of rows) {
        const e = found.get(r.wallet) ?? { userName: r.userName, xUsername: r.xUsername, boards: [], bestRank: Infinity };
        e.boards.push({ period: b.period, category: b.category, rank: r.rank, pnl: r.pnl, volumeShares: r.volumeShares });
        e.bestRank = Math.min(e.bestRank, r.rank);
        found.set(r.wallet, e);
      }
      discoveryState.done++;
    }
    const now = nowSec();
    const up = db.prepare('INSERT INTO candidates(address,user_name,x_username,boards,discovered_at,run_id) VALUES(?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET user_name=excluded.user_name,x_username=excluded.x_username,boards=excluded.boards,discovered_at=excluded.discovered_at,run_id=excluded.run_id');
    db.transaction(() => {
      for (const [a, e] of found) {
        up.run(a, e.userName, e.xUsername, JSON.stringify(e.boards), now, runId);
        if (e.userName) db.prepare('UPDATE wallets SET label=COALESCE(label, ?), user_name=? WHERE address=?').run(e.userName, e.userName, a);
      }
    })();
    // Prefer wallets appearing on several boards (multiple windows) — a weak but useful persistence prior.
    const order = [...found.entries()].sort((a, b) => b[1].boards.length - a[1].boards.length || a[1].bestRank - b[1].bestRank).slice(0, S.discovery.evaluateTop);
    Object.assign(discoveryState, { phase: 'Evaluating candidates', done: 0, total: order.length });
    let evaluated = 0;
    for (const [addr] of order) {
      try { await evaluateAndStore(db, provider, addr); evaluated++; } catch (e: any) { discoveryState.error = `Some evaluations failed (last: ${String(e.message).slice(0, 120)})`; }
      discoveryState.done++;
    }
    db.prepare('UPDATE discovery_runs SET finished_at=?, candidates=?, evaluated=?, error=? WHERE id=?').run(nowSec(), found.size, evaluated, discoveryState.error, runId);
  } catch (e: any) {
    discoveryState.error = String(e?.message || e);
    db.prepare('UPDATE discovery_runs SET finished_at=?, error=? WHERE id=?').run(nowSec(), discoveryState.error, runId);
  } finally {
    Object.assign(discoveryState, { running: false, phase: 'idle' });
  }
}
