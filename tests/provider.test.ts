import { describe, it, expect, vi } from 'vitest';
import { PolymarketProvider } from '../server/src/providers/polymarket.js';
import { HttpClient } from '../server/src/util/http.js';
import { categorize } from '../server/src/core/categories.js';

const json = (b: any) => new Response(JSON.stringify(b), { status: 200 });
const gammaMarket = (cid: string, closed: boolean) => ({ id: '1', conditionId: cid, question: 'Q', outcomes: '["Yes","No"]', clobTokenIds: '["a","b"]', outcomePrices: '["1","0"]', closed, active: !closed, tags: [{ label: 'Politics' }], feeSchedule: { rate: 0.04, exponent: 1 } });

describe('Polymarket provider mapping', () => {
  it('retries missing markets with closed=true (Gamma omits closed markets by default)', async () => {
    const f = vi.fn(async (url: string) => json(url.includes('closed=true') ? [gammaMarket('0xclosed', true)] : [gammaMarket('0xopen', false)]));
    const p = new PolymarketProvider(new HttpClient({ requestsPerSecond: 1000, fetchFn: f as any }));
    const ms = await p.getMarkets(['0xopen', '0xclosed']);
    expect(ms.map((m) => m.conditionId).sort()).toEqual(['0xclosed', '0xopen']);
    expect(ms.find((m) => m.conditionId === '0xclosed')!.outcomePrices).toEqual([1, 0]);
    expect((f.mock.calls.at(-1) as any[])[0]).toMatch(/condition_ids=0xclosed.*closed=true/);
  });

  it('never turns missing numbers into zero', () => {
    const p = new PolymarketProvider(new HttpClient({ requestsPerSecond: 1 }));
    const a = p.mapActivity({ proxy_wallet: '0xA', timestamp: 1, type: 'MERGE', condition_id: '0xc', token_id: '', side: '', outcome_index: 999, usdc_size: null, size: 5, price: 0 });
    expect(a.usdcSize).toBeNull();
    expect(a.price).toBeNull();        // non-trade rows carry no price
    expect(a.outcomeIndex).toBeNull(); // 999 sentinel = unlabeled
    expect(a.tokenId).toBeNull();
    const m = p.mapMarket({ conditionId: '0xC', question: 'Q', outcomes: '[]', clobTokenIds: '[]' });
    expect(m.feeRate).toBeNull();
    expect(m.liquidity).toBeNull();
  });

  it('closed positions are requested by time, never by PnL', async () => {
    const f = vi.fn(async () => json({ data: [], pagination: { has_more: false, next_cursor: null } }));
    const p = new PolymarketProvider(new HttpClient({ requestsPerSecond: 1000, fetchFn: f as any }));
    await p.getClosedPositions('0xw', { maxItems: 10 });
    expect((f.mock.calls[0] as any[])[0]).toMatch(/status=CLOSED.*sort_by=TIMESTAMP/);
  });
});

describe('categorize', () => {
  it('prefers Politics over Geopolitics for US elections tagged "Global Elections"', () => {
    expect(categorize(['Global Elections', 'United States', 'Politics', 'Senate Elections'])).toBe('Politics');
    expect(categorize(['Middle East', 'Iran'])).toBe('Geopolitics');
    expect(categorize(['NBA', 'Basketball'])).toBe('Sports');
    expect(categorize(['Something new'])).toBe('Other');
  });
});
