/**
 * Wallet evaluation — pure and deterministic.
 *
 * "Resolved / exited positions" = CLOSED positions (fully sold or redeemed) + OPEN positions flagged redeemable
 * (market resolved, tokens not yet redeemed — this includes resolved LOSERS, which Polymarket keeps in the OPEN set).
 * Position PnL for a redeemable row = realized + unrealized at the settlement price.
 *
 * Win rate     = share of resolved/exited positions with PnL > 0 (net of attributed fees). Shown with sample size.
 * Realized ROI = Σ PnL / Σ cost basis, where cost basis = avg entry price × total shares bought. It is a
 *                per-position return on capital deployed, NOT a portfolio return (deposits are not observable).
 * Drawdown     = largest peak-to-trough fall in the provider's cumulative marked trading PnL series (USD).
 * Consistency  = share of 30-day periods with positive change in that series, shrunk: (pos+1)/(n+2).
 */
import type { PnlPoint, PositionItem, UserStats } from '../providers/types.js';
import type { Settings } from '../settings.js';
import { DAY } from '../util/time.js';

export interface Component { value: number | null; score: number; available: boolean; detail: string }
export interface WalletMetrics {
  computedAt: number;
  sample: { resolved: number; closedFetched: number; redeemable: number; truncated: boolean; coversSince: number | null; note: string };
  winRate: number | null; wins: number; losses: number;
  realized: Record<'d30' | 'd90' | 'd365' | 'sample', { pnl: number | null; roi: number | null; count: number; available: boolean; note?: string }>;
  unrealizedOpen: number | null; openValue: number | null; openPositions: number;
  concentration: { top1Share: number | null; top3Share: number | null; grossProfit: number; biggestWin: number | null; biggestWinTitle: string | null };
  categories: { category: string; pnl: number; count: number }[];
  series: { available: boolean; days: number | null; maxDrawdown: number | null; months: number; positiveMonths: number; pnl30d: number | null; pnlLatest: number | null; points: { ts: number; v: number }[] };
  recency: { lastActivityAt: number | null; daysSince: number | null };
  behavior: { tradesPerMarket: number | null; makerRebateShare: number | null; twoSidedConditions: number; mergeCount: number | null };
  provider: { stats: UserStats | null; boards: any[] };
  score: { total: number; components: Record<string, Component>; weights: Settings['scoring']['weights'] };
  flags: { code: string; severity: 'info' | 'warning'; text: string }[];
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

export function evaluateWallet(input: {
  now: number; settings: Settings; closed: { items: PositionItem[]; hasMore: boolean }; open: PositionItem[] | null; series: PnlPoint[] | null;
  stats: UserStats | null; categoryOf: (conditionId: string) => string | null; lastActivityAt: number | null; mergeCount?: number | null; boards?: any[];
}): WalletMetrics {
  const { now, settings: S } = input;
  const sc = S.scoring;
  const redeemable = (input.open || []).filter((p) => p.redeemable);
  const resolved = [
    ...input.closed.items.map((p) => ({ p, pnl: p.realizedPnl })),
    ...redeemable.map((p) => ({ p, pnl: p.realizedPnl !== null && p.unrealizedPnl !== null ? p.realizedPnl + p.unrealizedPnl : null })),
  ].filter((x) => x.pnl !== null) as { p: PositionItem; pnl: number }[];

  const coversSince = input.closed.hasMore ? Math.min(...input.closed.items.map((p) => p.lastEventAt ?? now)) : null;
  const wins = resolved.filter((x) => x.pnl > 0).length;
  const losses = resolved.length - wins;

  const period = (days: number | null) => {
    const start = days === null ? -Infinity : now - days * DAY;
    if (days !== null && coversSince !== null && start < coversSince)
      return { pnl: null, roi: null, count: 0, available: false, note: `Sample truncated; covers only since ${new Date(coversSince * 1000).toISOString().slice(0, 10)}.` };
    const rows = resolved.filter((x) => (x.p.lastEventAt ?? 0) >= start);
    const pnl = rows.reduce((a, x) => a + x.pnl, 0);
    const cost = rows.reduce((a, x) => a + (x.p.costBasis ?? 0), 0);
    return { pnl: rows.length ? pnl : 0, roi: cost > 0 ? pnl / cost : null, count: rows.length, available: true };
  };
  const realized = { d30: period(30), d90: period(90), d365: period(365), sample: period(null) };

  const gross = resolved.filter((x) => x.pnl > 0).map((x) => x.pnl).sort((a, b) => b - a);
  const grossProfit = gross.reduce((a, b) => a + b, 0);
  const top = resolved.reduce<{ pnl: number; t: string | null } | null>((m, x) => (!m || x.pnl > m.pnl ? { pnl: x.pnl, t: x.p.title } : m), null);
  const concentration = {
    top1Share: grossProfit > 0 ? gross[0] / grossProfit : null,
    top3Share: grossProfit > 0 ? gross.slice(0, 3).reduce((a, b) => a + b, 0) / grossProfit : null,
    grossProfit, biggestWin: top && top.pnl > 0 ? top.pnl : null, biggestWinTitle: top && top.pnl > 0 ? top.t : null,
  };

  const catMap = new Map<string, { pnl: number; count: number }>();
  for (const x of resolved) {
    const c = input.categoryOf(x.p.conditionId) ?? 'Unclassified';
    const e = catMap.get(c) ?? { pnl: 0, count: 0 }; e.pnl += x.pnl; e.count++; catMap.set(c, e);
  }
  const categories = [...catMap.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));

  // series
  const pts = (input.series || []).filter((p) => p.positionPnl !== null).map((p) => ({ ts: p.ts, v: p.positionPnl! })).sort((a, b) => a.ts - b.ts);
  let maxDD: number | null = null, months = 0, posMonths = 0, pnl30d: number | null = null;
  const days = pts.length >= 2 ? (pts[pts.length - 1].ts - pts[0].ts) / DAY : null;
  if (pts.length >= 2) {
    let peak = pts[0].v; maxDD = 0;
    for (const p of pts) { peak = Math.max(peak, p.v); maxDD = Math.max(maxDD, peak - p.v); }
    const end = pts[pts.length - 1];
    const at = (t: number) => { let v: number | null = null; for (const p of pts) { if (p.ts <= t) v = p.v; else break; } return v; };
    const b30 = at(end.ts - 30 * DAY); pnl30d = b30 === null ? null : end.v - b30;
    for (let t = end.ts; t - 30 * DAY >= pts[0].ts; t -= 30 * DAY) { const a = at(t - 30 * DAY), b = at(t); if (a !== null && b !== null) { months++; if (b > a) posMonths++; } if (months >= 24) break; }
  }
  const step = Math.max(1, Math.floor(pts.length / 180));
  const series = { available: pts.length >= 2, days, maxDrawdown: maxDD, months, positiveMonths: posMonths, pnl30d, pnlLatest: pts.length ? pts[pts.length - 1].v : null, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1) };

  const openLive = (input.open || []).filter((p) => !p.redeemable);
  const lastFromPositions = Math.max(0, ...[...input.closed.items, ...(input.open || [])].map((p) => p.lastEventAt ?? 0));
  const lastActivityAt = Math.max(input.lastActivityAt ?? 0, lastFromPositions) || null;
  const daysSince = lastActivityAt ? (now - lastActivityAt) / DAY : null;

  // behaviour heuristics (uncertain by nature)
  const conds = new Map<string, number>();
  for (const p of openLive) if ((p.currentValue ?? 0) >= 10) conds.set(p.conditionId, (conds.get(p.conditionId) ?? 0) + 1);
  const twoSided = [...conds.values()].filter((c) => c >= 2).length;
  const st = input.stats;
  const tradesPerMarket = st && st.tradeCount !== null && st.marketsTraded ? st.tradeCount / st.marketsTraded : null;
  const makerRebateShare = st && st.makerRebate !== null && st.allTimePositionPnl ? st.makerRebate / Math.max(1, Math.abs(st.allTimePositionPnl)) : null;

  // ----- score components -----
  const comp: Record<string, Component> = {};
  const n = resolved.length;
  comp.sample = { value: n, available: true, score: clamp(Math.log(1 + n) / Math.log(1 + sc.fullSampleResolved)), detail: `${n} resolved/exited positions (saturates at ${sc.fullSampleResolved}).` };
  comp.consistency = months >= 3
    ? { value: posMonths / months, available: true, score: (posMonths + 1) / (months + 2), detail: `${posMonths}/${months} positive 30-day periods (shrunk toward 50%).` }
    : { value: null, available: false, score: 0, detail: 'Unavailable: fewer than 3 full 30-day periods of PnL history (scored 0).' };
  const roi = realized.sample.roi;
  comp.edge = roi !== null
    ? { value: roi, available: true, score: roi <= 0 ? 0 : clamp(roi / sc.edgeFullRoi), detail: `Realized ROI ${(roi * 100).toFixed(1)}% on cost basis (saturates at ${(sc.edgeFullRoi * 100).toFixed(0)}%).` }
    : { value: null, available: false, score: 0, detail: 'Unavailable: no cost basis in sample (scored 0).' };
  comp.recency = daysSince !== null
    ? { value: daysSince, available: true, score: daysSince <= sc.recencyFullDays ? 1 : clamp(1 - (daysSince - sc.recencyFullDays) / (sc.recencyZeroDays - sc.recencyFullDays)), detail: `Last activity ${daysSince.toFixed(1)} days ago.` }
    : { value: null, available: false, score: 0, detail: 'Unavailable: no activity timestamp (scored 0).' };
  comp.concentration = concentration.top1Share !== null
    ? { value: concentration.top1Share, available: true, score: clamp(1 - (concentration.top1Share - 0.15) / 0.6), detail: `Largest win = ${(concentration.top1Share * 100).toFixed(0)}% of gross profit.` }
    : { value: null, available: false, score: 0, detail: 'Unavailable: no winning positions in sample (scored 0).' };
  const checks = [
    { ok: series.available && (days ?? 0) >= sc.shortHistoryDays, t: `PnL series ≥ ${sc.shortHistoryDays} days` },
    { ok: !input.closed.hasMore || n >= 200, t: 'closed-position sample complete or ≥200' },
    { ok: !!st, t: 'profile stats available' },
    { ok: input.open !== null, t: 'open positions available' },
  ];
  comp.completeness = { value: checks.filter((c) => c.ok).length / checks.length, available: true, score: checks.filter((c) => c.ok).length / checks.length, detail: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.t}`).join('; ') };

  const W = sc.weights;
  const wsum = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  const total = (100 * (Object.keys(W) as (keyof typeof W)[]).reduce((a, k) => a + W[k] * (comp[k]?.score ?? 0), 0)) / wsum;

  const flags: WalletMetrics['flags'] = [];
  if (n < sc.smallSample) flags.push({ code: 'SMALL_SAMPLE', severity: 'warning', text: `Only ${n} resolved/exited positions — results may be luck.` });
  if (concentration.top1Share !== null && concentration.top1Share >= sc.oneWinShare) flags.push({ code: 'ONE_BIG_WIN', severity: 'warning', text: `One position produced ${(concentration.top1Share * 100).toFixed(0)}% of gross profit.` });
  if (!series.available || (days ?? 0) < sc.shortHistoryDays) flags.push({ code: 'SHORT_HISTORY', severity: 'warning', text: `PnL history shorter than ${sc.shortHistoryDays} days or unavailable.` });
  if (input.closed.hasMore) flags.push({ code: 'TRUNCATED_SAMPLE', severity: 'info', text: `Closed-position sample capped at ${input.closed.items.length} most recent; older history not evaluated.` });
  if (roi !== null && roi <= 0) flags.push({ code: 'NEGATIVE_EDGE', severity: 'warning', text: 'Realized PnL in sample is not positive.' });
  if (realized.d30.available && (realized.d30.pnl ?? 0) < 0) flags.push({ code: 'RECENT_LOSSES', severity: 'info', text: 'Realized PnL over the last 30 days is negative.' });
  if (daysSince !== null && daysSince > 30) flags.push({ code: 'INACTIVE', severity: 'warning', text: `No activity for ${daysSince.toFixed(0)} days.` });
  if ((tradesPerMarket ?? 0) > 300 || (makerRebateShare ?? 0) > 0.2) flags.push({ code: 'POSSIBLE_MARKET_MAKER', severity: 'info', text: `Possible market-making/automated trading (uncertain): ${tradesPerMarket !== null ? tradesPerMarket.toFixed(0) + ' fills per market' : ''}${makerRebateShare !== null ? `, maker rebates ≈ ${(makerRebateShare * 100).toFixed(0)}% of PnL` : ''}. Holdings may reflect inventory, not views.` });
  if (twoSided >= 3) flags.push({ code: 'TWO_SIDED', severity: 'info', text: `Holds both outcomes in ${twoSided} markets — possible hedging/market making (uncertain).` });

  return {
    computedAt: now,
    sample: { resolved: n, closedFetched: input.closed.items.length, redeemable: redeemable.length, truncated: input.closed.hasMore, coversSince,
      note: 'Closed positions fetched most-recent-first (never sorted by PnL, which would sample only winners), plus resolved-unredeemed positions.' },
    winRate: n ? wins / n : null, wins, losses, realized,
    unrealizedOpen: input.open ? openLive.reduce((a, p) => a + (p.unrealizedPnl ?? 0), 0) : null,
    openValue: input.open ? openLive.reduce((a, p) => a + (p.currentValue ?? 0), 0) : null, openPositions: openLive.length,
    concentration, categories, series, recency: { lastActivityAt, daysSince },
    behavior: { tradesPerMarket, makerRebateShare, twoSidedConditions: twoSided, mergeCount: input.mergeCount ?? null },
    provider: { stats: st, boards: input.boards || [] },
    score: { total, components: comp, weights: W }, flags,
  };
}
