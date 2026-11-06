/**
 * In-memory provider used by automated tests and by `npm run demo`.
 * Demo mode always runs against a separate database file and the UI shows a permanent DEMO banner.
 * It is never used as a fallback when the live provider fails.
 */
import type { ActivityItem, LeaderboardEntry, MarketDataProvider, MarketInfo, OrderBook, Page, PnlPoint, PositionItem, UserStats } from './types.js';

export class FixtureProvider implements MarketDataProvider {
  readonly platform = 'fixture';
  activity = new Map<string, ActivityItem[]>();
  open = new Map<string, PositionItem[]>();
  closed = new Map<string, PositionItem[]>();
  series = new Map<string, PnlPoint[]>();
  stats = new Map<string, UserStats>();
  markets = new Map<string, MarketInfo>();
  books = new Map<string, OrderBook>();
  leaderboard: LeaderboardEntry[] = [];
  fail = new Set<string>(); // method names that should throw (simulated provider outage)
  calls: string[] = [];

  private guard(name: string) { this.calls.push(name); if (this.fail.has(name)) throw new Error(`simulated ${name} failure`); }

  async getLeaderboard(p: { limit: number }) { this.guard('getLeaderboard'); return this.leaderboard.slice(0, p.limit); }
  async getActivity(wallet: string, p: { start: number; maxItems: number; newestFirst?: boolean }): Promise<Page<ActivityItem>> {
    this.guard('getActivity');
    const all = (this.activity.get(wallet) || []).filter((a) => a.ts >= p.start).sort((a, b) => a.ts - b.ts);
    if (p.newestFirst) return { items: all.slice(Math.max(0, all.length - p.maxItems)), hasMore: all.length > p.maxItems };
    return { items: all.slice(0, p.maxItems), hasMore: all.length > p.maxItems };
  }
  async getOpenPositions(wallet: string) { this.guard('getOpenPositions'); return { items: [...(this.open.get(wallet) || [])], hasMore: false }; }
  async getClosedPositions(wallet: string, p: { maxItems: number }) {
    this.guard('getClosedPositions');
    const all = [...(this.closed.get(wallet) || [])].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
    return { items: all.slice(0, p.maxItems), hasMore: all.length > p.maxItems };
  }
  async getPnlSeries(wallet: string) { this.guard('getPnlSeries'); return this.series.get(wallet) ?? null; }
  async getUserStats(wallet: string) { this.guard('getUserStats'); return this.stats.get(wallet) ?? null; }
  async getMarkets(ids: string[]) { this.guard('getMarkets'); return ids.map((i) => this.markets.get(i.toLowerCase())).filter(Boolean) as MarketInfo[]; }
  async getOrderBooks(ids: string[]) { this.guard('getOrderBooks'); const now = Math.floor(Date.now() / 1000); return ids.map((i) => this.books.get(i)).filter(Boolean).map((b) => ({ ...b!, fetchedAt: Math.max(b!.fetchedAt, now) })); }
  async getPriceHistory() { return []; }
  marketUrl(e: string | null, s: string | null) { return e || s ? `https://polymarket.com/event/${e || s}` : null; }
  walletUrl(w: string) { return `https://polymarket.com/profile/${w}`; }
  txUrl(t: string) { return `https://polygonscan.com/tx/${t}`; }
}

// ---------- builders shared by tests and demo seed ----------
export function mkPosition(p: Partial<PositionItem> & { wallet: string; tokenId: string; conditionId: string; size: number }): PositionItem {
  return {
    outcome: 'Yes', outcomeIndex: 0, oppositeTokenId: null, totalBought: p.size, avgPrice: 0.5, costBasis: null, currentPrice: 0.5, currentValue: p.size * (p.currentPrice ?? 0.5),
    realizedPnl: 0, unrealizedPnl: 0, status: 'OPEN', redeemable: false, negativeRisk: false, title: 'Test market', slug: 'test', eventSlug: 'test', eventId: 'ev1', endDate: null,
    firstEntryAt: null, lastEventAt: null, ...p,
  } as PositionItem;
}
export function mkMarket(p: Partial<MarketInfo> & { conditionId: string; tokenIds: string[] }): MarketInfo {
  return {
    marketId: '1', question: 'Test market?', slug: 'test', eventSlug: 'test', eventTitle: 'Test event', eventId: 'ev1', category: 'Politics', tags: ['Politics'],
    outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5], active: true, closed: false, resolutionStatus: null, endDate: null, negRisk: false,
    feeRate: 0.04, feeExponent: 1, liquidity: 10000, url: 'https://polymarket.com/event/test', ...p,
  } as MarketInfo;
}
export function mkBook(tokenId: string, bid: number, ask: number, size = 1000, fetchedAt = Math.floor(Date.now() / 1000)): OrderBook {
  return { tokenId, bids: [{ price: bid, size }, { price: +(bid - 0.01).toFixed(3), size }], asks: [{ price: ask, size }, { price: +(ask + 0.01).toFixed(3), size }], bookTs: fetchedAt, fetchedAt };
}
