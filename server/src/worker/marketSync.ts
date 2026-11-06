import type { DB } from '../db.js';
import type { MarketDataProvider, MarketInfo } from '../providers/types.js';

export function getMarket(db: DB, conditionId: string): MarketInfo | null {
  const r = db.prepare('SELECT json FROM markets WHERE condition_id=?').get(conditionId.toLowerCase()) as any;
  return r ? JSON.parse(r.json) : null;
}

export function getMarkets(db: DB, ids: string[]): Map<string, MarketInfo> {
  const out = new Map<string, MarketInfo>();
  if (!ids.length) return out;
  const uniq = [...new Set(ids.map((x) => x.toLowerCase()))];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const rows = db.prepare(`SELECT json FROM markets WHERE condition_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[];
    for (const r of rows) { const m = JSON.parse(r.json); out.set(m.conditionId, m); }
  }
  return out;
}

export function storeMarkets(db: DB, markets: MarketInfo[], now: number) {
  const st = db.prepare('INSERT INTO markets(condition_id,json,category,closed,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(condition_id) DO UPDATE SET json=excluded.json, category=excluded.category, closed=excluded.closed, updated_at=excluded.updated_at');
  db.transaction(() => { for (const m of markets) st.run(m.conditionId, JSON.stringify(m), m.category, m.closed ? 1 : 0, now); })();
}

const notFound = new Map<string, number>();

/**
 * Fetch metadata for markets we hold/track that are missing or stale (closed markets are not refreshed).
 * Priority: active signals, paper orders, then followed-wallet holdings by value (dust last).
 */
export async function syncMarkets(db: DB, provider: MarketDataProvider, refreshSec: number, now: number, extraIds: string[] = [], perPass = 1500) {
  const ids = (db.prepare(`
    SELECT condition_id AS c, 3 AS pri, 0 AS v FROM signals WHERE ended_at IS NULL
    UNION ALL SELECT condition_id, 2, 0 FROM paper_orders
    UNION ALL SELECT p.condition_id, 1, SUM(COALESCE(p.current_value,0)) FROM positions p JOIN wallets w ON w.address=p.wallet AND w.followed=1 WHERE p.redeemable=0 GROUP BY p.condition_id
  `).all() as any[]).sort((a, b) => b.pri - a.pri || b.v - a.v).map((r) => String(r.c).toLowerCase());
  const all = [...new Set([...extraIds.map((x) => x.toLowerCase()), ...ids])];
  const stmt = db.prepare('SELECT updated_at, closed FROM markets WHERE condition_id=?');
  const need: string[] = [];
  for (const c of all) {
    const r = stmt.get(c) as any;
    if ((notFound.get(c) ?? 0) > now - 3600) continue;
    if (!r || (!r.closed && now - r.updated_at > refreshSec)) need.push(c);
    if (need.length >= perPass) break;
  }
  if (!need.length) return 0;
  const ms = await provider.getMarkets(need);
  storeMarkets(db, ms, now);
  // Remember ids the provider did not return so they don't crowd out others for an hour.
  const got = new Set(ms.map((m) => m.conditionId));
  for (const c of need) if (!got.has(c)) notFound.set(c, now);
  return ms.length;
}
