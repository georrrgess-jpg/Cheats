/**
 * Consensus engine — pure and deterministic. No I/O; every input is passed in, so it is fully unit-testable.
 *
 * Definitions
 *  - Unit: one independent supporter. A wallet, or a cluster of wallets (user-declared cluster tag, or a
 *    heuristically suspected link when `collapseSuspectedLinks` is on). Repeated trades never add units.
 *  - Current agreement: units that hold NET exposure to the outcome token right now, according to the latest
 *    successfully reconciled positions. Net = shares(token) − shares(complement) on the same condition, because a
 *    YES+NO pair is redeemable for $1 and carries no directional view. Exited wallets hold nothing and so vanish.
 *  - Opposing: units whose net exposure is to the complementary outcome of the same condition.
 *  - Eligible wallets: followed wallets whose positions were refreshed within `staleAfterSec`. Stale wallets are
 *    excluded from support AND from the denominator, and are listed separately.
 */
import type { MarketInfo } from '../providers/types.js';
import type { Settings } from '../settings.js';

export interface WalletIn { address: string; label: string | null; cluster: string | null; quality: number | null; positionsSyncedAt: number | null }
export interface PositionIn {
  wallet: string; tokenId: string; conditionId: string; outcome: string | null; outcomeIndex: number | null; oppositeTokenId: string | null;
  size: number; avgPrice: number | null; currentPrice: number | null; redeemable: boolean; firstEntryAt: number | null;
  title: string | null; eventId: string | null; eventSlug: string | null; slug: string | null;
}
export interface QuoteIn { tokenId: string; bestBid: number | null; bestAsk: number | null; asks: { price: number; size: number }[]; bids: { price: number; size: number }[]; fetchedAt: number }
export interface FlowIn { wallet: string; tokenId: string | null; conditionId: string | null; type: string; side: string | null; usdcSize: number | null; size: number | null; ts: number; isBackfill?: boolean }
export interface ChangeIn { wallet: string; tokenId: string; ts: number; prevSize: number; newSize: number; isBaseline: boolean }

export interface UnitWallet { address: string; label: string | null; quality: number | null; netShares: number; value: number | null; avgPrice: number | null; firstEntryAt: number | null }
export interface Unit {
  id: string; kind: 'wallet' | 'cluster' | 'suspected-link'; wallets: UnitWallet[];
  netShares: number; value: number | null; quality: number; qualityKnown: boolean; avgPrice: number | null;
  weightShare?: number; // capped share of quality weight
  exposureShare?: number; // capped share of exposure weight
}
export interface ScoreComponents { breadth: number; quality: number; exposure: number; momentum: number }
export interface ConsensusResult {
  tokenId: string; conditionId: string; outcome: string | null; outcomeIndex: number | null; oppositeTokenId: string | null;
  title: string; eventTitle: string | null; eventId: string | null; category: string; url: string | null; negRisk: boolean;
  supporters: Unit[]; opposers: Unit[]; otherOutcomeHolders: { tokenId: string; title: string; units: number }[];
  supportCount: number; opposeCount: number; eligibleUnits: number; eligibleWallets: number; followedWallets: number;
  staleHolders: { address: string; label: string | null; lastSyncAt: number | null }[];
  supportValue: number | null; opposeValue: number | null; supportShares: number;
  entry: { weightedAvgPrice: number | null; coverage: number; earliestEntryAt: number | null; formedAt: number | null; note: string };
  quote: null | { bid: number | null; ask: number | null; mid: number | null; spread: number | null; fetchedAt: number; ageSec: number;
    probe: { usd: number; avgPrice: number | null; shares: number; fillable: boolean; slippagePct: number | null } };
  flows: { windowSec: number; inflowUsd: number; outflowUsd: number; increasingUnits: string[]; reducingUnits: string[]; exitedUnits: string[]; liveReducingUnits: string[]; backfillIncluded: boolean };
  score: { total: number; components: ScoreComponents; weights: Settings['consensus']['weights'] };
  dataQuality: { grade: 'High' | 'Medium' | 'Low'; coverage: number; issues: string[] };
  flags: string[];
}

/** Cap each weight's share of the total at `cap` via water-filling. If cap is infeasible (n*cap<1) weights become equal. */
export function capShares(weights: number[], cap: number): number[] {
  const n = weights.length;
  if (!n) return [];
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return weights.map(() => 1 / n);
  if (n * cap <= 1) return weights.map(() => 1 / n);
  let shares = weights.map((w) => Math.max(0, w) / total);
  const capped = new Array(n).fill(false);
  for (let iter = 0; iter < n; iter++) {
    const over = shares.map((s, i) => !capped[i] && s > cap + 1e-12);
    if (!over.some(Boolean)) break;
    over.forEach((o, i) => { if (o) capped[i] = true; });
    const fixed = capped.filter(Boolean).length * cap;
    const freeTotal = weights.reduce((a, w, i) => a + (capped[i] ? 0 : Math.max(0, w)), 0);
    shares = weights.map((w, i) => (capped[i] ? cap : freeTotal > 0 ? (Math.max(0, w) / freeTotal) * (1 - fixed) : (1 - fixed) / Math.max(1, n - capped.filter(Boolean).length)));
  }
  return shares;
}

/** Union-find clustering: user-declared clusters always merge; suspected links merge only if configured. */
export function clusterWallets(wallets: WalletIn[], holdings: Map<string, Set<string>>, s: Settings['consensus']) {
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  wallets.forEach((w) => parent.set(w.address, w.address));
  const byCluster = new Map<string, string>();
  for (const w of wallets) if (w.cluster) { const c = w.cluster.trim().toLowerCase(); if (byCluster.has(c)) union(byCluster.get(c)!, w.address); else byCluster.set(c, w.address); }
  const suspected: { a: string; b: string; jaccard: number }[] = [];
  for (let i = 0; i < wallets.length; i++) for (let j = i + 1; j < wallets.length; j++) {
    const A = holdings.get(wallets[i].address), B = holdings.get(wallets[j].address);
    if (!A || !B || A.size < 5 || B.size < 5) continue;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    const jac = inter / (A.size + B.size - inter);
    if (jac >= s.linkJaccard) { suspected.push({ a: wallets[i].address, b: wallets[j].address, jaccard: jac }); if (s.collapseSuspectedLinks) union(wallets[i].address, wallets[j].address); }
  }
  const unitOf = new Map<string, string>();
  for (const w of wallets) unitOf.set(w.address, find(w.address));
  return { unitOf, suspected, declared: byCluster };
}

/** Walk an order book side to estimate execution of `usd` notional (buy) — no fees here, purely book depth. */
export function probeBuy(asks: { price: number; size: number }[], usd: number) {
  let rem = usd, shares = 0, cost = 0;
  for (const l of asks) { if (rem <= 1e-9) break; const take = Math.min(l.size, rem / l.price); shares += take; cost += take * l.price; rem -= take * l.price; }
  const fillable = rem <= 1e-6;
  return { usd, shares, avgPrice: shares > 0 ? cost / shares : null, fillable };
}

const QUALITY_UNKNOWN = 50; // neutral weight used (and disclosed) when a wallet has not been evaluated

export function computeConsensus(input: {
  now: number; settings: Settings; wallets: WalletIn[]; positions: PositionIn[]; markets: Map<string, MarketInfo>;
  quotes: Map<string, QuoteIn>; flows: FlowIn[]; changes: ChangeIn[]; windowSec?: number;
}): { results: ConsensusResult[]; suspectedLinks: { a: string; b: string; jaccard: number }[]; eligibleWallets: number; staleWallets: string[] } {
  const { now, settings: S, markets, quotes } = input;
  const s = S.consensus;
  const windowSec = input.windowSec ?? s.recentWindowSec;

  const fresh = (w: WalletIn) => w.positionsSyncedAt !== null && now - w.positionsSyncedAt <= S.tracking.staleAfterSec;
  const qualOk = (w: WalletIn) => w.quality === null || w.quality >= s.minQualityScore;
  const eligible = input.wallets.filter((w) => fresh(w) && qualOk(w));
  const staleWallets = input.wallets.filter((w) => !fresh(w)).map((w) => w.address);
  const wByAddr = new Map(input.wallets.map((w) => [w.address, w]));
  const eligibleSet = new Set(eligible.map((w) => w.address));

  // Live, non-resolved positions only.
  const isLive = (p: PositionIn) => {
    if (p.redeemable) return false;
    const m = markets.get(p.conditionId.toLowerCase());
    return !(m && m.closed);
  };
  const priceOf = (tokenId: string, fallback: number | null) => {
    const q = quotes.get(tokenId);
    if (q && q.bestBid !== null && q.bestAsk !== null) return (q.bestBid + q.bestAsk) / 2;
    return fallback;
  };

  // shares by wallet -> condition -> token
  const byWalletCond = new Map<string, Map<string, Map<string, PositionIn>>>();
  const holdings = new Map<string, Set<string>>();
  for (const p of input.positions) {
    if (!isLive(p)) continue;
    if (!byWalletCond.has(p.wallet)) byWalletCond.set(p.wallet, new Map());
    const mc = byWalletCond.get(p.wallet)!;
    if (!mc.has(p.conditionId)) mc.set(p.conditionId, new Map());
    mc.get(p.conditionId)!.set(p.tokenId, p);
  }

  // Net directional exposure per wallet per condition.
  interface Net { wallet: string; tokenId: string; conditionId: string; netShares: number; value: number | null; pos: PositionIn }
  const nets: Net[] = [];
  const staleNets: Net[] = [];
  for (const [wallet, mc] of byWalletCond) {
    for (const [, toks] of mc) {
      const arr = [...toks.values()];
      const a = arr[0];
      const opp = a.oppositeTokenId ? toks.get(a.oppositeTokenId) : arr[1];
      let main = a, net = a.size - (opp?.size ?? 0);
      if (net < 0 && opp) { main = opp; net = -net; }
      if (net <= 1e-9) continue;
      const px = priceOf(main.tokenId, main.currentPrice);
      const value = px === null ? null : net * px;
      if (value !== null && value < s.minPositionUsd) continue;
      if (value === null && (main.avgPrice ?? 0) * net < s.minPositionUsd) continue;
      const rec = { wallet, tokenId: main.tokenId, conditionId: main.conditionId, netShares: net, value, pos: main };
      if (eligibleSet.has(wallet)) { nets.push(rec); if (!holdings.has(wallet)) holdings.set(wallet, new Set()); holdings.get(wallet)!.add(main.tokenId); }
      else staleNets.push(rec);
    }
  }

  const { unitOf, suspected, declared } = clusterWallets(eligible, holdings, s);
  const suspectedMembers = new Set(suspected.flatMap((x) => [x.a, x.b]));
  const unitIds = new Set(eligible.map((w) => unitOf.get(w.address)!));

  // complement lookup
  const complementOf = new Map<string, string>();
  for (const p of input.positions) if (p.oppositeTokenId) { complementOf.set(p.tokenId, p.oppositeTokenId); complementOf.set(p.oppositeTokenId, p.tokenId); }
  for (const m of markets.values()) if (m.tokenIds.length === 2) { complementOf.set(m.tokenIds[0], m.tokenIds[1]); complementOf.set(m.tokenIds[1], m.tokenIds[0]); }

  const byToken = new Map<string, Net[]>();
  for (const n of nets) { if (!byToken.has(n.tokenId)) byToken.set(n.tokenId, []); byToken.get(n.tokenId)!.push(n); }

  const buildUnits = (rows: Net[]): Unit[] => {
    const g = new Map<string, Net[]>();
    for (const r of rows) { const u = unitOf.get(r.wallet)!; if (!g.has(u)) g.set(u, []); g.get(u)!.push(r); }
    return [...g.entries()].map(([id, rs]) => {
      const ws: UnitWallet[] = rs.map((r) => {
        const w = wByAddr.get(r.wallet)!;
        return { address: r.wallet, label: w.label, quality: w.quality, netShares: r.netShares, value: r.value, avgPrice: r.pos.avgPrice, firstEntryAt: r.pos.firstEntryAt };
      });
      const knownQ = ws.filter((w) => w.quality !== null);
      const quality = knownQ.length ? Math.max(...knownQ.map((w) => w.quality!)) : QUALITY_UNKNOWN;
      const value = ws.some((w) => w.value === null) ? null : ws.reduce((a, w) => a + (w.value ?? 0), 0);
      const shares = ws.reduce((a, w) => a + w.netShares, 0);
      const priced = ws.filter((w) => w.avgPrice !== null);
      const avg = priced.length === ws.length && shares > 0 ? priced.reduce((a, w) => a + w.avgPrice! * w.netShares, 0) / shares : null;
      const kind: Unit['kind'] = ws.length === 1 ? 'wallet' : ws.some((w) => wByAddr.get(w.address)?.cluster && declared.has(wByAddr.get(w.address)!.cluster!.trim().toLowerCase())) ? 'cluster' : 'suspected-link';
      return { id, kind, wallets: ws, netShares: shares, value, quality, qualityKnown: knownQ.length > 0, avgPrice: avg };
    }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  };

  // event -> tokens held (for "other outcomes in this event" on multi-outcome events)
  const eventHoldings = new Map<string, Map<string, { title: string; units: Set<string> }>>();
  for (const n of nets) {
    const ev = n.pos.eventId; if (!ev) continue;
    if (!eventHoldings.has(ev)) eventHoldings.set(ev, new Map());
    const m = eventHoldings.get(ev)!;
    if (!m.has(n.tokenId)) m.set(n.tokenId, { title: `${n.pos.outcome ?? '?'} — ${n.pos.title ?? n.conditionId}`, units: new Set() });
    m.get(n.tokenId)!.units.add(unitOf.get(n.wallet)!);
  }

  const since = now - windowSec;
  const results: ConsensusResult[] = [];
  for (const [tokenId, rows] of byToken) {
    const supporters = buildUnits(rows);
    if (supporters.length < s.minSupport) continue;
    const comp = complementOf.get(tokenId) ?? rows[0].pos.oppositeTokenId ?? null;
    const opposers = comp ? buildUnits(byToken.get(comp) ?? []) : [];
    const p0 = rows[0].pos;
    const m = markets.get(p0.conditionId.toLowerCase()) ?? null;
    const supportValue = supporters.some((u) => u.value === null) ? null : supporters.reduce((a, u) => a + u.value!, 0);
    const opposeValue = opposers.some((u) => u.value === null) ? null : opposers.reduce((a, u) => a + u.value!, 0);
    const supportShares = supporters.reduce((a, u) => a + u.netShares, 0);

    // --- score components ---
    const all = [...supporters, ...opposers];
    const qShares = capShares(all.map((u) => u.quality), s.maxInfluenceShare);
    all.forEach((u, i) => (u.weightShare = qShares[i]));
    // quality = (capped quality-weighted share of support vs opposition) × (mean supporter quality / 100)
    const qualityShare = supporters.reduce((a, u) => a + (u.weightShare ?? 0), 0);
    const meanSupQ = supporters.reduce((a, u) => a + u.quality, 0) / supporters.length / 100;
    const qualityAgree = qualityShare * meanSupQ;
    const vShares = capShares(all.map((u) => u.value ?? 0), s.maxInfluenceShare);
    all.forEach((u, i) => (u.exposureShare = vShares[i]));
    const exposureAgree = supporters.reduce((a, u) => a + (u.exposureShare ?? 0), 0);
    const breadth = Math.min(1, supporters.length / Math.max(1, s.breadthTarget));

    // --- recent flows (directional only: trades). Buying this token or selling its complement = inflow. ---
    let inflow = 0, outflow = 0;
    const inc = new Set<string>(), red = new Set<string>(), liveRed = new Set<string>();
    const netByUnit = new Map<string, number>(), liveNetByUnit = new Map<string, number>();
    let backfillIncluded = false;
    for (const f of input.flows) {
      if (f.ts < since || f.type !== 'TRADE' || !eligibleSet.has(f.wallet) || f.usdcSize === null) continue;
      let dir = 0;
      if (f.tokenId === tokenId) dir = f.side === 'BUY' ? 1 : f.side === 'SELL' ? -1 : 0;
      else if (comp && f.tokenId === comp) dir = f.side === 'BUY' ? -1 : f.side === 'SELL' ? 1 : 0;
      if (!dir) continue;
      if (dir > 0) inflow += f.usdcSize; else outflow += f.usdcSize;
      const u = unitOf.get(f.wallet)!;
      netByUnit.set(u, (netByUnit.get(u) ?? 0) + dir * f.usdcSize);
      if (f.isBackfill) backfillIncluded = true; else liveNetByUnit.set(u, (liveNetByUnit.get(u) ?? 0) + dir * f.usdcSize);
    }
    for (const [u, v] of netByUnit) { if (v > 0) inc.add(u); else if (v < 0) red.add(u); }
    for (const [u, v] of liveNetByUnit) if (v < 0) liveRed.add(u);
    const exited = new Set<string>();
    for (const c of input.changes) {
      if (c.tokenId !== tokenId || c.ts < since || c.isBaseline || !eligibleSet.has(c.wallet)) continue;
      const u = unitOf.get(c.wallet)!;
      if (c.newSize <= 1e-6 && c.prevSize > 0) exited.add(u);
      else if (c.newSize < c.prevSize * (1 - S.alerts.exitReducePct)) { red.add(u); liveRed.add(u); }
      else if (c.newSize > c.prevSize) inc.add(u);
    }
    for (const u of exited) { red.add(u); liveRed.add(u); inc.delete(u); }
    const momentum = inflow + outflow > 0 ? 0.5 + 0.5 * ((inflow - outflow) / (inflow + outflow)) : 0.5;

    const W = s.weights;
    const wsum = W.breadth + W.quality + W.exposure + W.momentum || 1;
    const components = { breadth, quality: qualityAgree, exposure: exposureAgree, momentum };
    const total = (100 * (W.breadth * breadth + W.quality * qualityAgree + W.exposure * exposureAgree + W.momentum * momentum)) / wsum;

    // --- quote ---
    const q = quotes.get(tokenId);
    let quote: ConsensusResult['quote'] = null;
    if (q) {
      const mid = q.bestBid !== null && q.bestAsk !== null ? (q.bestBid + q.bestAsk) / 2 : null;
      const pr = probeBuy(q.asks, s.depthProbeUsd);
      quote = {
        bid: q.bestBid, ask: q.bestAsk, mid, spread: q.bestBid !== null && q.bestAsk !== null ? q.bestAsk - q.bestBid : null, fetchedAt: q.fetchedAt, ageSec: now - q.fetchedAt,
        probe: { ...pr, slippagePct: pr.avgPrice !== null && q.bestAsk ? (pr.avgPrice - q.bestAsk) / q.bestAsk : null },
      };
    }

    // --- entry prices (provider average cost; may be incomplete) ---
    const sw = supporters.flatMap((u) => u.wallets);
    const priced = sw.filter((w) => w.avgPrice !== null);
    const pricedShares = priced.reduce((a, w) => a + w.netShares, 0);
    const totShares = sw.reduce((a, w) => a + w.netShares, 0);
    const entries = sw.map((w) => w.firstEntryAt).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const formedAt = entries.length >= s.minSupport ? entries[s.minSupport - 1] : null;

    // --- data quality (separate from agreement strength) ---
    const issues: string[] = [];
    const coverage = input.wallets.length ? eligible.length / input.wallets.length : 0;
    if (coverage < 1) issues.push(`${input.wallets.length - eligible.length} of ${input.wallets.length} followed wallets not refreshed recently or below quality threshold; excluded from counts.`);
    if (!q) issues.push('No order book quote yet — executable price unavailable.');
    else if (now - q.fetchedAt > s.quoteStaleSec) issues.push(`Quote is ${Math.round((now - q.fetchedAt) / 60)} min old.`);
    if (q && (q.bestAsk === null || q.bestBid === null)) issues.push('One side of the order book is empty.');
    if (!m) issues.push('Market metadata not loaded yet (category / resolution status unknown).');
    if (pricedShares < totShares) issues.push('Some supporter entry prices unavailable.');
    if (supporters.some((u) => !u.qualityKnown)) issues.push(`Some supporters not yet evaluated — neutral quality ${QUALITY_UNKNOWN} used.`);
    const staleHolders = staleNets.filter((n) => n.tokenId === tokenId).map((n) => ({ address: n.wallet, label: wByAddr.get(n.wallet)?.label ?? null, lastSyncAt: wByAddr.get(n.wallet)?.positionsSyncedAt ?? null }));
    const quoteFresh = !!q && now - q.fetchedAt <= s.quoteStaleSec && q.bestAsk !== null;
    const grade: 'High' | 'Medium' | 'Low' = coverage >= 0.9 && quoteFresh && !!m && pricedShares >= totShares * 0.9 ? 'High' : coverage >= 0.6 && !!q ? 'Medium' : 'Low';

    const flags: string[] = [];
    if (supporters.some((u) => u.kind !== 'wallet')) flags.push('Some supporters are clusters counted once (declared or suspected links).');
    if (supporters.some((u) => u.wallets.some((w) => suspectedMembers.has(w.address)))) flags.push('Suspected linked wallets among supporters (position-set overlap). Independence unverified.');
    if (opposers.length) flags.push('Followed wallets disagree on this market.');
    const px = quote?.mid ?? null;
    if (px !== null && (px >= 0.95 || px <= 0.05)) flags.push(`Price ${(px * 100).toFixed(1)}¢: near-certain outcome. Agreement here often reflects low-upside "yield" positions rather than new information; a small payoff carries tail risk.`);
    if (m?.negRisk) flags.push('Multi-outcome event: holdings of other outcomes are listed separately; they are not counted as opposition.');
    if (supporters.some((u) => (u.exposureShare ?? 0) >= s.maxInfluenceShare - 1e-9 && all.length * s.maxInfluenceShare > 1)) flags.push(`Influence cap (${Math.round(s.maxInfluenceShare * 100)}%) applied to the largest supporter.`);

    const others = p0.eventId && m?.negRisk ? [...(eventHoldings.get(p0.eventId)?.entries() ?? [])].filter(([t]) => t !== tokenId && t !== comp).map(([t, v]) => ({ tokenId: t, title: v.title, units: v.units.size })) : [];

    results.push({
      tokenId, conditionId: p0.conditionId, outcome: p0.outcome, outcomeIndex: p0.outcomeIndex, oppositeTokenId: comp,
      title: m?.question || p0.title || p0.conditionId, eventTitle: m?.eventTitle ?? null, eventId: p0.eventId, category: m?.category ?? 'Unknown',
      url: m?.url ?? null, negRisk: !!m?.negRisk,
      supporters, opposers, otherOutcomeHolders: others,
      supportCount: supporters.length, opposeCount: opposers.length, eligibleUnits: unitIds.size, eligibleWallets: eligible.length, followedWallets: input.wallets.length,
      staleHolders, supportValue, opposeValue, supportShares,
      entry: {
        weightedAvgPrice: pricedShares > 0 ? priced.reduce((a, w) => a + w.avgPrice! * w.netShares, 0) / pricedShares : null,
        coverage: totShares > 0 ? pricedShares / totShares : 0, earliestEntryAt: entries[0] ?? null, formedAt,
        note: 'Provider-reported average cost per supporter, weighted by current net shares. Excludes positions entered via transfers/splits without a price; not a price you could have obtained.',
      },
      quote,
      flows: { windowSec, inflowUsd: inflow, outflowUsd: outflow, increasingUnits: [...inc], reducingUnits: [...red], exitedUnits: [...exited], liveReducingUnits: [...liveRed], backfillIncluded },
      score: { total, components, weights: W },
      dataQuality: { grade, coverage, issues },
      flags,
    });
  }
  results.sort((a, b) => b.score.total - a.score.total);
  return { results, suspectedLinks: suspected, eligibleWallets: eligible.length, staleWallets };
}
