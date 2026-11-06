import type { DB } from '../db.js';
import type { MarketDataProvider, OrderBook } from '../providers/types.js';

export interface Quote { tokenId: string; bestBid: number | null; bestAsk: number | null; bids: { price: number; size: number }[]; asks: { price: number; size: number }[]; bookTs: number | null; fetchedAt: number }

export function storeBooks(db: DB, books: OrderBook[]) {
  const st = db.prepare(`INSERT INTO quotes(token_id,best_bid,best_ask,bids,asks,book_ts,fetched_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(token_id) DO UPDATE SET best_bid=excluded.best_bid,best_ask=excluded.best_ask,bids=excluded.bids,asks=excluded.asks,book_ts=excluded.book_ts,fetched_at=excluded.fetched_at`);
  db.transaction(() => {
    for (const b of books) st.run(b.tokenId, b.bids[0]?.price ?? null, b.asks[0]?.price ?? null, JSON.stringify(b.bids.slice(0, 40)), JSON.stringify(b.asks.slice(0, 40)), b.bookTs, b.fetchedAt);
  })();
}

export function getQuotes(db: DB, tokens: string[]): Map<string, Quote> {
  const out = new Map<string, Quote>();
  const uniq = [...new Set(tokens)];
  for (let i = 0; i < uniq.length; i += 500) {
    const c = uniq.slice(i, i + 500);
    if (!c.length) continue;
    for (const r of db.prepare(`SELECT * FROM quotes WHERE token_id IN (${c.map(() => '?').join(',')})`).all(...c) as any[]) {
      out.set(r.token_id, { tokenId: r.token_id, bestBid: r.best_bid, bestAsk: r.best_ask, bids: JSON.parse(r.bids), asks: JSON.parse(r.asks), bookTs: r.book_ts, fetchedAt: r.fetched_at });
    }
  }
  return out;
}

/**
 * Tokens worth quoting, in priority order: active signals (+ complements) and paper holdings first,
 * then any token held by >= 2 followed wallets (pre-consensus candidates).
 */
export function tokensToQuote(db: DB, minPositionUsd: number, cap = 2000): string[] {
  const pri = db.prepare(`
    SELECT token_id t FROM signals WHERE ended_at IS NULL
    UNION SELECT p.opposite_token_id FROM signals s JOIN positions p ON p.token_id=s.token_id WHERE s.ended_at IS NULL
    UNION SELECT token_id FROM paper_orders`).all() as any[];
  const rest = db.prepare(`
    SELECT token_id t FROM positions p JOIN wallets w ON w.address=p.wallet AND w.followed=1
      WHERE p.redeemable=0 AND p.size*COALESCE(p.current_price,0) >= ? GROUP BY token_id HAVING COUNT(DISTINCT p.wallet) >= 2
      ORDER BY SUM(p.size*COALESCE(p.current_price,0)) DESC`).all(minPositionUsd) as any[];
  const out = new Set<string>();
  for (const r of [...pri, ...rest]) { if (r.t) out.add(r.t); if (out.size >= cap) break; }
  return [...out];
}

export async function syncQuotes(db: DB, provider: MarketDataProvider, tokens: string[]) {
  if (!tokens.length) return 0;
  const books = await provider.getOrderBooks(tokens.slice(0, 2000));
  storeBooks(db, books);
  return books.length;
}
