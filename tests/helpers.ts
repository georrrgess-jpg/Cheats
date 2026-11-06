import { openDb, type DB } from '../server/src/db.js';
import { DEFAULT_SETTINGS, type Settings } from '../server/src/settings.js';
import { FixtureProvider, mkBook, mkMarket, mkPosition } from '../server/src/providers/fixture.js';
import type { WalletIn, PositionIn } from '../server/src/core/consensus.js';
import type { ActivityItem } from '../server/src/providers/types.js';

export const S = (): Settings => structuredClone(DEFAULT_SETTINGS);
export const NOW = 1_800_000_000;
export const addr = (i: number) => '0x' + String(i).padStart(40, '0');

export function freshDb(): DB { return openDb(':memory:'); }

export function wallet(i: number, over: Partial<WalletIn> = {}): WalletIn {
  return { address: addr(i), label: `W${i}`, cluster: null, quality: 60, positionsSyncedAt: NOW - 10, ...over };
}
export function pos(i: number, token: string, size: number, over: Partial<PositionIn> = {}): PositionIn {
  const comp = token.endsWith('_yes') ? token.replace('_yes', '_no') : token.replace('_no', '_yes');
  return { wallet: addr(i), tokenId: token, conditionId: token.split('_')[0], outcome: token.endsWith('_yes') ? 'Yes' : 'No', outcomeIndex: token.endsWith('_yes') ? 0 : 1,
    oppositeTokenId: comp, size, avgPrice: 0.5, currentPrice: 0.5, redeemable: false, firstEntryAt: NOW - 1000, title: 'M', eventId: 'e', eventSlug: 'e', slug: 's', ...over };
}
export function act(i: number, ts: number, over: Partial<ActivityItem> = {}): ActivityItem {
  return { wallet: addr(i), ts, type: 'TRADE', rawType: 'TRADE', conditionId: 'c1', tokenId: 'c1_yes', outcome: 'Yes', outcomeIndex: 0, side: 'BUY', size: 100, usdcSize: 50, price: 0.5,
    txHash: `0xtx${ts}`, title: 'M', slug: 's', eventSlug: 'e', ...over };
}
export { FixtureProvider, mkBook, mkMarket, mkPosition };
