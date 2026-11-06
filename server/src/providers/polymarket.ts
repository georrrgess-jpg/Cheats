import { HttpClient } from '../util/http.js';
import { categorize } from '../core/categories.js';
import type {
  ActivityItem, ActivityType, LeaderboardEntry, MarketDataProvider, MarketInfo, OrderBook, Page, PnlPoint, PositionItem, UserStats,
} from './types.js';

const DATA = 'https://data-api.polymarket.com/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** Number or null — never coerces a missing value into 0. */
const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
};
const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const parseJsonArr = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
};

interface Envelope<T> { data: T; pagination?: { has_more: boolean; next_cursor: string | null } }

const TYPE_MAP: Record<string, ActivityType> = {
  TRADE: 'TRADE', SPLIT: 'SPLIT', MERGE: 'MERGE', REDEEM: 'REDEEM', CONVERSION: 'CONVERSION',
  DIRECTIONAL_SPLIT: 'SPLIT', DIRECTIONAL_MERGE: 'MERGE', THRESHOLD_COMPOSE: 'CONVERSION', THRESHOLD_DECOMPOSE: 'CONVERSION',
  MIGRATION: 'TRANSFER', REWARD: 'REWARD', YIELD: 'REWARD', REFERRAL_REWARD: 'REWARD', MAKER_REBATE: 'REBATE', TAKER_REBATE: 'REBATE',
};

export class PolymarketProvider implements MarketDataProvider {
  readonly platform = 'polymarket';
  constructor(readonly http: HttpClient) {}

  private async walk<T>(firstUrl: string, buildNext: (cursor: string) => string, maxItems: number): Promise<Page<T>> {
    const items: T[] = [];
    let url = firstUrl;
    for (;;) {
      const r = await this.http.request<Envelope<T[]>>(url);
      items.push(...(r.data || []));
      const cur = r.pagination?.next_cursor;
      if (!r.pagination?.has_more || !cur) return { items, hasMore: false };
      if (items.length >= maxItems) return { items, hasMore: true };
      url = buildNext(cur);
    }
  }

  async getLeaderboard(p: { period: 'day' | 'week' | 'month' | 'all'; category?: string; limit: number }): Promise<LeaderboardEntry[]> {
    const q = new URLSearchParams({ time_period: p.period, sort_by: 'PNL', limit: String(Math.min(p.limit, 1000)), category: (p.category || 'overall').toLowerCase() });
    const r = await this.http.request<Envelope<any[]>>(`${DATA}/leaderboard?${q}`);
    return (r.data || []).map((x) => ({
      rank: Number(x.rank), wallet: String(x.user_id).toLowerCase(), userName: s(x.user_name), xUsername: s(x.x_username),
      pnl: n(x.pnl), volumeShares: n(x.volume),
    }));
  }

  async getActivity(wallet: string, p: { start: number; maxItems: number; newestFirst?: boolean }): Promise<Page<ActivityItem>> {
    // Filters must be identical on every page (documented: cursor carries only the seek anchor).
    const base = new URLSearchParams({ user: wallet, limit: '500', sort_direction: p.newestFirst ? 'DESC' : 'ASC', start: String(Math.max(1, p.start)) });
    const page = await this.walk<any>(`${DATA}/activity?${base}`, (c) => `${DATA}/activity?${base}&cursor=${encodeURIComponent(c)}`, p.maxItems);
    const items = page.items.map((x) => this.mapActivity(x));
    if (p.newestFirst) items.reverse();
    return { hasMore: page.hasMore, items };
  }

  mapActivity(x: any): ActivityItem {
    const raw = String(x.type || 'OTHER');
    const oi = n(x.outcome_index);
    return {
      wallet: String(x.proxy_wallet).toLowerCase(), ts: Number(x.timestamp), type: TYPE_MAP[raw] ?? 'OTHER', rawType: raw,
      conditionId: s(x.condition_id), tokenId: s(x.token_id), outcome: s(x.outcome), outcomeIndex: oi === 999 ? null : oi,
      side: x.side === 'BUY' || x.side === 'SELL' ? x.side : null,
      size: n(x.size), usdcSize: n(x.usdc_size), price: raw === 'TRADE' ? n(x.price) : null,
      txHash: s(x.transaction_hash), title: s(x.title), slug: s(x.slug), eventSlug: s(x.event_slug),
    };
  }

  mapPosition(x: any): PositionItem {
    const avg = n(x.avg_price), tot = n(x.total_size);
    return {
      wallet: String(x.proxy_wallet).toLowerCase(), tokenId: String(x.token_id), conditionId: String(x.condition_id),
      outcome: s(x.outcome), outcomeIndex: n(x.outcome_index) === 999 ? null : n(x.outcome_index), oppositeTokenId: s(x.opposite_token_id),
      size: n(x.current_size) ?? 0, totalBought: tot, avgPrice: avg, costBasis: avg !== null && tot !== null ? avg * tot : null,
      currentPrice: n(x.current_price), currentValue: n(x.current_value), realizedPnl: n(x.realized_pnl), unrealizedPnl: n(x.unrealized_pnl),
      status: x.status === 'CLOSED' ? 'CLOSED' : x.redeemable ? 'REDEEMABLE' : 'OPEN', redeemable: !!x.redeemable, negativeRisk: !!x.negative_risk,
      title: s(x.title), slug: s(x.slug), eventSlug: s(x.event_slug), eventId: s(x.event_id), endDate: s(x.end_date),
      firstEntryAt: n(x.first_entry_at), lastEventAt: n(x.last_event_at),
    };
  }

  async getOpenPositions(wallet: string, p: { maxItems?: number } = {}): Promise<Page<PositionItem>> {
    // OPEN is the documented superset (includes resolved-but-unredeemed rows, flagged redeemable).
    // filter_amount=0.01 shares keeps tiny holdings so a near-full exit still reads as "holding dust", not missing.
    const base = new URLSearchParams({ user: wallet, limit: '500', status: 'OPEN' });
    const page = await this.walk<any>(`${DATA}/positions?${base}`, (c) => `${DATA}/positions?user=${wallet}&cursor=${encodeURIComponent(c)}`, p.maxItems ?? 5000);
    return { hasMore: page.hasMore, items: page.items.map((x) => this.mapPosition(x)) };
  }

  async getClosedPositions(wallet: string, p: { maxItems: number }): Promise<Page<PositionItem>> {
    // IMPORTANT: default CLOSED sort is REALIZED_PNL; a truncated walk would then sample only winners. Sort by time instead.
    const base = new URLSearchParams({ user: wallet, limit: '500', status: 'CLOSED', sort_by: 'TIMESTAMP', sort_direction: 'DESC' });
    const page = await this.walk<any>(`${DATA}/positions?${base}`, (c) => `${DATA}/positions?user=${wallet}&cursor=${encodeURIComponent(c)}`, p.maxItems);
    return { hasMore: page.hasMore, items: page.items.map((x) => this.mapPosition(x)) };
  }

  async getPnlSeries(wallet: string): Promise<PnlPoint[] | null> {
    const r = await this.http.request<Envelope<any>>(`${DATA}/user-pnl?user=${wallet}&interval=all&fidelity=1d`);
    if (!r.data || !Array.isArray(r.data.points)) return null;
    return r.data.points.map((p: any) => ({
      ts: Number(p.timestamp), positionPnl: n(p.position_pnl), realizedPnl: n(p.realized_pnl), makerRebate: n(p.maker_rebate),
      volumeUsd: n(p.volume_usdc), tradeCount: n(p.trade_count),
    }));
  }

  async getUserStats(wallet: string): Promise<UserStats | null> {
    const r = await this.http.request<Envelope<any>>(`${DATA}/user-stats?user=${wallet}`);
    if (!r.data) return null;
    const a = r.data.all_time_pnl || {};
    return {
      marketsTraded: n(r.data.trades), biggestWin: n(r.data.biggest_win), joinDate: n(r.data.join_date),
      allTimeRealizedPnl: n(a.realized_pnl), allTimePositionPnl: n(a.position_pnl), makerRebate: n(a.maker_rebate),
      tradeCount: n(a.trade_count), volumeUsd: n(a.volume_usdc),
    };
  }

  async getMarkets(conditionIds: string[]): Promise<MarketInfo[]> {
    // Verified live: Gamma omits CLOSED markets unless closed=true is passed, so query open first, then retry the misses.
    const out: MarketInfo[] = [];
    const fetchChunked = async (ids: string[], extra: string) => {
      for (let i = 0; i < ids.length; i += 50) {
        const q = ids.slice(i, i + 50).map((c) => `condition_ids=${c}`).join('&');
        const rows = await this.http.request<any[]>(`${GAMMA}/markets?${q}&include_tag=true&limit=100${extra}`);
        for (const m of rows || []) out.push(this.mapMarket(m));
      }
    };
    await fetchChunked(conditionIds, '');
    const got = new Set(out.map((m) => m.conditionId));
    const missing = conditionIds.filter((c) => !got.has(c.toLowerCase()));
    if (missing.length) await fetchChunked(missing, '&closed=true');
    return out;
  }

  mapMarket(m: any): MarketInfo {
    const ev = Array.isArray(m.events) && m.events[0] ? m.events[0] : null;
    const tags: string[] = [...(m.tags || []), ...((ev && ev.tags) || [])].map((t: any) => String(t.label || t.slug || '')).filter(Boolean);
    const fs = m.feeSchedule || null;
    const feeRate = m.feesEnabled === false ? 0 : fs ? n(fs.rate) : null;
    return {
      conditionId: String(m.conditionId).toLowerCase(), marketId: s(String(m.id ?? '')), question: String(m.question || ''),
      slug: s(m.slug), eventSlug: ev ? s(ev.slug) : null, eventTitle: ev ? s(ev.title) : null, eventId: ev ? s(String(ev.id ?? '')) : null,
      category: categorize(tags), tags: [...new Set(tags)],
      outcomes: parseJsonArr(m.outcomes).map(String), tokenIds: parseJsonArr(m.clobTokenIds).map(String),
      outcomePrices: parseJsonArr(m.outcomePrices).map(n),
      active: !!m.active, closed: !!m.closed, resolutionStatus: s(m.umaResolutionStatus), endDate: s(m.endDate), negRisk: !!m.negRisk,
      feeRate, feeExponent: fs ? n(fs.exponent) : feeRate === 0 ? 1 : null, liquidity: n(m.liquidityNum ?? m.liquidity),
      url: this.marketUrl(ev ? s(ev.slug) : null, s(m.slug)),
    };
  }

  async getOrderBooks(tokenIds: string[]): Promise<OrderBook[]> {
    const out: OrderBook[] = [];
    for (let i = 0; i < tokenIds.length; i += 200) {
      const chunk = tokenIds.slice(i, i + 200);
      const rows = await this.http.request<any[]>(`${CLOB}/books`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk.map((t) => ({ token_id: t }))),
      });
      const fetchedAt = Math.floor(Date.now() / 1000);
      for (const b of rows || []) {
        const lv = (a: any[]) => (a || []).map((l) => ({ price: Number(l.price), size: Number(l.size) })).filter((l) => l.size > 0 && Number.isFinite(l.price));
        out.push({
          tokenId: String(b.asset_id), bids: lv(b.bids).sort((a, b) => b.price - a.price), asks: lv(b.asks).sort((a, b) => a.price - b.price),
          bookTs: b.timestamp ? Math.floor(Number(b.timestamp) / 1000) : null, fetchedAt,
        });
      }
    }
    return out;
  }

  async getPriceHistory(tokenId: string, interval: '1d' | '1w' | '1m' | 'max') {
    const r = await this.http.request<Envelope<any[]>>(`${DATA}/prices-history?token_id=${tokenId}&interval=${interval}`);
    return (r.data || []).map((p) => ({ ts: Number(p.timestamp), price: Number(p.price) })).filter((p) => Number.isFinite(p.price));
  }

  marketUrl(eventSlug: string | null, slug: string | null) {
    if (eventSlug && slug && eventSlug !== slug) return `https://polymarket.com/event/${eventSlug}/${slug}`;
    if (eventSlug || slug) return `https://polymarket.com/event/${eventSlug || slug}`;
    return null;
  }
  walletUrl(w: string) { return `https://polymarket.com/profile/${w}`; }
  txUrl(tx: string) { return `https://polygonscan.com/tx/${tx}`; }
}
