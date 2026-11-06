import type { DB } from '../db.js';
import type { Settings } from '../settings.js';
import { computeConsensus, type ChangeIn, type FlowIn, type PositionIn, type WalletIn } from './consensus.js';
import { getMarkets } from '../worker/marketSync.js';
import { getQuotes } from '../worker/quoteSync.js';

export function loadWallets(db: DB): WalletIn[] {
  return (db.prepare(`SELECT w.address, w.label, w.cluster, s.positions_synced_at, m.json AS mjson FROM wallets w
    LEFT JOIN wallet_sync s ON s.address=w.address LEFT JOIN wallet_metrics m ON m.address=w.address WHERE w.followed=1`).all() as any[])
    .map((r) => ({ address: r.address, label: r.label, cluster: r.cluster, positionsSyncedAt: r.positions_synced_at ?? null, quality: r.mjson ? JSON.parse(r.mjson).score?.total ?? null : null }));
}

export function runConsensusFromDb(db: DB, S: Settings, now: number, windowSec?: number) {
  const wallets = loadWallets(db);
  const positions: PositionIn[] = (db.prepare(`SELECT p.* FROM positions p JOIN wallets w ON w.address=p.wallet AND w.followed=1 WHERE p.redeemable=0`).all() as any[]).map((r) => ({
    wallet: r.wallet, tokenId: r.token_id, conditionId: r.condition_id, outcome: r.outcome, outcomeIndex: r.outcome_index, oppositeTokenId: r.opposite_token_id,
    size: r.size, avgPrice: r.avg_price, currentPrice: r.current_price, redeemable: !!r.redeemable, firstEntryAt: r.first_entry_at,
    title: r.title, eventId: r.event_id, eventSlug: r.event_slug, slug: r.slug,
  }));
  const win = windowSec ?? S.consensus.recentWindowSec;
  const flows: FlowIn[] = (db.prepare(`SELECT a.wallet, a.token_id, a.condition_id, a.type, a.side, a.usdc_size, a.size, a.ts, a.is_backfill FROM activity a JOIN wallets w ON w.address=a.wallet AND w.followed=1 WHERE a.ts>=? AND a.type='TRADE'`).all(now - win) as any[])
    .map((r) => ({ wallet: r.wallet, tokenId: r.token_id, conditionId: r.condition_id, type: r.type, side: r.side, usdcSize: r.usdc_size, size: r.size, ts: r.ts, isBackfill: !!r.is_backfill }));
  const changes: ChangeIn[] = (db.prepare(`SELECT wallet, token_id, ts, prev_size, new_size, is_baseline FROM position_changes WHERE ts>=?`).all(now - win) as any[])
    .map((r) => ({ wallet: r.wallet, tokenId: r.token_id, ts: r.ts, prevSize: r.prev_size, newSize: r.new_size, isBaseline: !!r.is_baseline }));
  const conds = [...new Set(positions.map((p) => p.conditionId))];
  const markets = getMarkets(db, conds);
  const toks = [...new Set(positions.flatMap((p) => [p.tokenId, p.oppositeTokenId].filter(Boolean) as string[]))];
  const quotes = getQuotes(db, toks);
  return computeConsensus({ now, settings: S, wallets, positions, markets, quotes, flows, changes, windowSec: win });
}
