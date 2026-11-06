import crypto from 'node:crypto';
import type { DB } from '../db.js';
import type { ActivityItem, MarketDataProvider } from '../providers/types.js';
import type { Settings } from '../settings.js';
import { DAY } from '../util/time.js';

/**
 * Deterministic dedupe key. The provider gives no row id, so we hash the economically meaningful fields and
 * append an ordinal for identical rows inside the same fetch (e.g. two identical fills in one transaction).
 * Every fetch starts at a timestamp boundary (inclusive), so groups sharing a timestamp are always re-read
 * from their beginning and ordinals are stable across runs.
 */
export function activityKeys(items: ActivityItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((a) => {
    const base = crypto.createHash('sha1')
      .update([a.wallet, a.ts, a.rawType, a.txHash, a.conditionId, a.tokenId, a.side, a.size, a.usdcSize, a.price].join('|'))
      .digest('hex').slice(0, 24);
    const ord = seen.get(base) ?? 0;
    seen.set(base, ord + 1);
    return `${base}#${ord}`;
  });
}

export interface ActivitySyncResult { fetched: number; inserted: number; liveInserted: number; hasMore: boolean }

export async function syncWalletActivity(db: DB, provider: MarketDataProvider, wallet: string, s: Settings, now: number): Promise<ActivitySyncResult> {
  db.prepare('INSERT OR IGNORE INTO wallet_sync(address) VALUES(?)').run(wallet);
  const st = db.prepare('SELECT * FROM wallet_sync WHERE address=?').get(wallet) as any;
  const initial = !st.backfill_done;
  const start: number = st.activity_cursor_ts ?? now - s.tracking.initialBackfillDays * DAY;
  try {
    // Initial load walks newest-first so the recent feed is complete even for very active wallets; if the cap is hit,
    // coverage starts at the oldest fetched row and is recorded as truncated (never silently claimed as full).
    const page = await provider.getActivity(wallet, { start, maxItems: s.tracking.maxBackfillItems, newestFirst: initial });
    const keys = activityKeys(page.items);
    const ins = db.prepare(`INSERT OR IGNORE INTO activity(id,wallet,ts,type,raw_type,condition_id,token_id,outcome,outcome_index,side,size,usdc_size,price,tx_hash,title,slug,event_slug,observed_at,is_backfill)
      VALUES(@id,@wallet,@ts,@type,@rawType,@conditionId,@tokenId,@outcome,@outcomeIndex,@side,@size,@usdcSize,@price,@txHash,@title,@slug,@eventSlug,@observedAt,@isBackfill)`);
    let inserted = 0, liveInserted = 0;
    let maxTs = st.activity_cursor_ts ?? null;
    db.transaction(() => {
      page.items.forEach((a, i) => {
        // Rows from the initial backfill, or observed long after they happened (downtime recovery), are historical:
        // they are stored and shown, but never treated as "just happened" for alerts.
        const isBackfill = initial || now - a.ts > s.tracking.liveObservationLagSec ? 1 : 0;
        const r = ins.run({ ...a, id: keys[i], observedAt: now, isBackfill });
        if (r.changes) { inserted++; if (!isBackfill) liveInserted++; }
        if (maxTs === null || a.ts > maxTs) maxTs = a.ts;
      });
      if (initial) {
        const oldest = page.items.length ? page.items[0].ts : start;
        db.prepare(`UPDATE wallet_sync SET activity_cursor_ts=?, activity_synced_at=?, activity_error=NULL, activity_failures=0,
          backfill_done=1, backfill_from=?, backfill_truncated=? WHERE address=?`).run(maxTs ?? now, now, page.hasMore ? oldest : start, page.hasMore ? 1 : 0, wallet);
      } else {
        db.prepare(`UPDATE wallet_sync SET activity_cursor_ts=?, activity_synced_at=?, activity_error=NULL, activity_failures=0 WHERE address=?`).run(maxTs ?? start, now, wallet);
      }
    })();
    // For incremental ASC walks, hasMore means newer rows remain: the scheduler continues immediately.
    return { fetched: page.items.length, inserted, liveInserted, hasMore: initial ? false : page.hasMore };
  } catch (e: any) {
    db.prepare('UPDATE wallet_sync SET activity_error=?, activity_error_at=?, activity_failures=activity_failures+1 WHERE address=?')
      .run(String(e?.message || e).slice(0, 300), now, wallet);
    throw e;
  }
}
