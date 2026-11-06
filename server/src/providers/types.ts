/**
 * Platform-neutral data contracts. A provider (Polymarket today) maps its API into these.
 * Convention: `null` means "unavailable / not reported" and must never be treated as zero.
 * All timestamps are epoch SECONDS.
 */

export type ActivityType =
  | 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'CONVERSION' | 'TRANSFER' | 'REWARD' | 'REBATE' | 'OTHER';

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  userName: string | null;
  xUsername: string | null;
  pnl: number | null;      // provider-reported, see period semantics
  volumeShares: number | null; // shares, not USD
}

export interface ActivityItem {
  wallet: string;
  ts: number;
  type: ActivityType;
  rawType: string;
  conditionId: string | null;
  tokenId: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  side: 'BUY' | 'SELL' | null;
  size: number | null;     // shares
  usdcSize: number | null; // USD notional
  price: number | null;
  txHash: string | null;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
}

export interface PositionItem {
  wallet: string;
  tokenId: string;
  conditionId: string;
  outcome: string | null;
  outcomeIndex: number | null;
  oppositeTokenId: string | null;
  size: number;            // current shares held
  totalBought: number | null; // total shares acquired over the position's life
  avgPrice: number | null;
  costBasis: number | null; // avgPrice * totalBought (USD)
  currentPrice: number | null;
  currentValue: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  status: 'OPEN' | 'CLOSED' | 'REDEEMABLE';
  redeemable: boolean;
  negativeRisk: boolean;
  title: string | null;
  slug: string | null;
  eventSlug: string | null;
  eventId: string | null;
  endDate: string | null;
  firstEntryAt: number | null;
  lastEventAt: number | null;
}

export interface PnlPoint {
  ts: number;
  positionPnl: number | null; // realized + unrealized (marked) trading PnL, cumulative
  realizedPnl: number | null;
  makerRebate: number | null;
  volumeUsd: number | null;
  tradeCount: number | null;
}

export interface UserStats {
  marketsTraded: number | null;
  biggestWin: number | null;
  joinDate: number | null;
  allTimeRealizedPnl: number | null;
  allTimePositionPnl: number | null;
  makerRebate: number | null;
  tradeCount: number | null;
  volumeUsd: number | null;
}

export interface MarketInfo {
  conditionId: string;
  marketId: string | null;
  question: string;
  slug: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
  eventId: string | null;
  category: string;
  tags: string[];
  outcomes: string[];
  tokenIds: string[];
  outcomePrices: (number | null)[];
  active: boolean;
  closed: boolean;
  resolutionStatus: string | null;
  endDate: string | null;
  negRisk: boolean;
  feeRate: number | null;     // taker fee rate, null if unknown
  feeExponent: number | null;
  liquidity: number | null;
  url: string | null;
}

export interface BookLevel { price: number; size: number }
export interface OrderBook {
  tokenId: string;
  bids: BookLevel[]; // sorted best (highest) first
  asks: BookLevel[]; // sorted best (lowest) first
  bookTs: number | null; // provider timestamp (seconds)
  fetchedAt: number;
}

export interface Page<T> { items: T[]; hasMore: boolean }

export interface MarketDataProvider {
  readonly platform: string;
  getLeaderboard(p: { period: 'day' | 'week' | 'month' | 'all'; category?: string; limit: number }): Promise<LeaderboardEntry[]>;
  /**
   * Activity with ts >= start, returned in ASCENDING time order. `newestFirst` walks from now backwards (used for the
   * initial load so recent activity is always present); `hasMore` then means older rows were left unfetched.
   */
  getActivity(wallet: string, p: { start: number; maxItems: number; newestFirst?: boolean }): Promise<Page<ActivityItem>>;
  getOpenPositions(wallet: string, p?: { maxItems?: number }): Promise<Page<PositionItem>>;
  /** Closed positions, MOST RECENT FIRST (sorted by last event, never by PnL, to avoid winner-only samples). */
  getClosedPositions(wallet: string, p: { maxItems: number }): Promise<Page<PositionItem>>;
  getPnlSeries(wallet: string): Promise<PnlPoint[] | null>;
  getUserStats(wallet: string): Promise<UserStats | null>;
  getMarkets(conditionIds: string[]): Promise<MarketInfo[]>;
  getOrderBooks(tokenIds: string[]): Promise<OrderBook[]>;
  getPriceHistory(tokenId: string, interval: '1d' | '1w' | '1m' | 'max'): Promise<{ ts: number; price: number }[]>;
  marketUrl(eventSlug: string | null, slug: string | null): string | null;
  walletUrl(wallet: string): string;
  txUrl(tx: string): string;
}
