import type { DB } from '../db.js';
import type { MarketDataProvider, PositionItem } from '../providers/types.js';
import type { Settings } from '../settings.js';

const EPS = 1e-6;

/**
 * Reconcile one wallet's current holdings against the provider's authoritative position list.
 * The stored set is REPLACED atomically (so exits disappear), and every size change is written to
 * position_changes. Changes seen on the first sync, or after a gap longer than 2x the stale threshold,
 * are flagged as baseline so they never fire "just happened" alerts.
 */
export async function syncWalletPositions(db: DB, provider: MarketDataProvider, wallet: string, s: Settings, now: number) {
  db.prepare('INSERT OR IGNORE INTO wallet_sync(address) VALUES(?)').run(wallet);
  const st = db.prepare('SELECT positions_synced_at FROM wallet_sync WHERE address=?').get(wallet) as any;
  let page;
  try {
    page = await provider.getOpenPositions(wallet);
  } catch (e: any) {
    db.prepare('UPDATE wallet_sync SET positions_error=?, positions_error_at=?, positions_failures=positions_failures+1 WHERE address=?')
      .run(String(e?.message || e).slice(0, 300), now, wallet);
    throw e;
  }
  applyPositions(db, wallet, page.items, page.hasMore, st?.positions_synced_at ?? null, s, now);
  return { count: page.items.length, truncated: page.hasMore };
}

export function applyPositions(db: DB, wallet: string, items: PositionItem[], truncated: boolean, prevSyncAt: number | null, s: Settings, now: number) {
  const baseline = prevSyncAt === null || now - prevSyncAt > 2 * s.tracking.staleAfterSec ? 1 : 0;
  const prev = new Map<string, any>((db.prepare('SELECT token_id, size, condition_id FROM positions WHERE wallet=?').all(wallet) as any[]).map((r) => [r.token_id, r]));
  const ins = db.prepare(`INSERT INTO positions(wallet,token_id,condition_id,outcome,outcome_index,opposite_token_id,size,total_bought,avg_price,cost_basis,current_price,current_value,realized_pnl,unrealized_pnl,redeemable,negative_risk,title,slug,event_slug,event_id,end_date,first_entry_at,last_event_at,synced_at)
    VALUES(@wallet,@tokenId,@conditionId,@outcome,@outcomeIndex,@oppositeTokenId,@size,@totalBought,@avgPrice,@costBasis,@currentPrice,@currentValue,@realizedPnl,@unrealizedPnl,@redeemable,@negativeRisk,@title,@slug,@eventSlug,@eventId,@endDate,@firstEntryAt,@lastEventAt,@syncedAt)`);
  const chg = db.prepare('INSERT INTO position_changes(wallet,token_id,condition_id,ts,prev_size,new_size,price,is_baseline) VALUES(?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    db.prepare('DELETE FROM positions WHERE wallet=?').run(wallet);
    const seen = new Set<string>();
    for (const p of items) {
      if (seen.has(p.tokenId)) continue; // defensive: never double count a token
      seen.add(p.tokenId);
      ins.run({ ...p, wallet, redeemable: p.redeemable ? 1 : 0, negativeRisk: p.negativeRisk ? 1 : 0, syncedAt: now });
      const before = prev.get(p.tokenId)?.size ?? 0;
      if (Math.abs(before - p.size) > EPS) chg.run(wallet, p.tokenId, p.conditionId, now, before, p.size, p.currentPrice, baseline);
    }
    // tokens no longer returned => fully exited (or redeemed / transferred out)
    for (const [tok, r] of prev) if (!seen.has(tok) && r.size > EPS) chg.run(wallet, tok, r.condition_id, now, r.size, 0, null, baseline);
    db.prepare('UPDATE wallet_sync SET positions_synced_at=?, positions_error=NULL, positions_failures=0, positions_truncated=? WHERE address=?').run(now, truncated ? 1 : 0, wallet);
  })();
}
