import type { DB } from './db.js';
import { nowSec } from './util/time.js';

/**
 * Every tunable threshold lives here. Any change creates a new immutable settings version,
 * and paper orders / signals record the version that was active, so results stay interpretable.
 */
export interface Settings {
  tracking: {
    activityPollSec: number;      // per-wallet incremental activity poll interval
    positionsPollSec: number;     // per-wallet position reconciliation interval
    quotesPollSec: number;        // order-book refresh for consensus/paper tokens
    marketsRefreshSec: number;    // Gamma metadata refresh for open markets
    initialBackfillDays: number;  // history fetched when a wallet is first followed
    maxBackfillItems: number;     // cap per wallet per backfill run
    liveObservationLagSec: number;// activity observed later than this after its trade time is treated as backfill (no alerts)
    staleAfterSec: number;        // position data older than this => wallet excluded from consensus denominators
  };
  consensus: {
    minPositionUsd: number;       // ignore holdings worth less than this (dust)
    minSupport: number;           // supporters needed to form a consensus result
    breadthTarget: number;        // supporters at which the breadth component saturates
    maxInfluenceShare: number;    // cap on any one wallet/cluster's share of weighted support
    minQualityScore: number;      // wallets below this quality score are not counted
    collapseSuspectedLinks: boolean; // treat heuristically similar wallets as one cluster (conservative)
    linkJaccard: number;          // position-set overlap that triggers a suspected-link flag
    recentWindowSec: number;      // default window for inflow / outflow
    trendLookbackSec: number;     // compare with snapshot this long ago for Building / Weakening
    newWindowSec: number;         // "New agreement" if first detected within this window
    changeExposurePct: number;    // relative exposure change considered meaningful
    quoteStaleSec: number;        // quotes older than this mark a result Stale
    depthProbeUsd: number;        // order size used to report executable depth/slippage
    weights: { breadth: number; quality: number; exposure: number; momentum: number };
  };
  scoring: {
    weights: { consistency: number; edge: number; sample: number; recency: number; concentration: number; completeness: number };
    fullSampleResolved: number;   // resolved positions at which the sample component saturates
    smallSample: number;          // below this => SMALL_SAMPLE flag
    oneWinShare: number;          // top single win share of gross profit => ONE_BIG_WIN flag
    shortHistoryDays: number;
    recencyFullDays: number;
    recencyZeroDays: number;
    edgeFullRoi: number;          // realized ROI at which the edge component saturates
    closedSampleMax: number;      // closed positions fetched per wallet evaluation
  };
  alerts: {
    convergenceMinSupport: number;
    increaseMinDelta: number;     // supporters added within lookback
    exitMinWallets: number;       // supporters reducing/exiting within window
    exitReducePct: number;        // a reduction of at least this share of a holding counts as "reducing"
    cooldownSec: number;
    healthFailureThreshold: number; // consecutive provider failures before alerting
    staleWalletShare: number;     // share of followed wallets stale before alerting
  };
  paper: {
    defaultOrderUsd: number;
    maxSlippagePct: number;       // limit = best price * (1 + this) for buys
    extraSlippageBps: number;     // added on top of book walk (latency / queue uncertainty)
    simulatedLatencySec: number;  // quote must be fetched at least this long after the decision
    autoRule: { enabled: boolean; minScore: number; minSupport: number; orderUsd: number; states: string[]; exitOnEnd: boolean; maxOpen: number };
  };
  discovery: {
    boards: { period: 'week' | 'month' | 'all'; category: string; limit: number }[];
    evaluateTop: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  tracking: {
    activityPollSec: 60, positionsPollSec: 180, quotesPollSec: 60, marketsRefreshSec: 1800,
    initialBackfillDays: 30, maxBackfillItems: 5000, liveObservationLagSec: 900, staleAfterSec: 900,
  },
  consensus: {
    minPositionUsd: 100, minSupport: 2, breadthTarget: 5, maxInfluenceShare: 0.35, minQualityScore: 0,
    collapseSuspectedLinks: true, linkJaccard: 0.8, recentWindowSec: 86400, trendLookbackSec: 86400, newWindowSec: 6 * 3600,
    changeExposurePct: 0.2, quoteStaleSec: 600, depthProbeUsd: 500,
    weights: { breadth: 0.35, quality: 0.25, exposure: 0.25, momentum: 0.15 },
  },
  scoring: {
    weights: { consistency: 0.3, edge: 0.15, sample: 0.2, recency: 0.1, concentration: 0.15, completeness: 0.1 },
    fullSampleResolved: 100, smallSample: 20, oneWinShare: 0.5, shortHistoryDays: 60,
    recencyFullDays: 7, recencyZeroDays: 60, edgeFullRoi: 0.25, closedSampleMax: 1000,
  },
  alerts: {
    convergenceMinSupport: 3, increaseMinDelta: 2, exitMinWallets: 2, exitReducePct: 0.5, cooldownSec: 6 * 3600,
    healthFailureThreshold: 3, staleWalletShare: 0.3,
  },
  paper: {
    defaultOrderUsd: 250, maxSlippagePct: 0.05, extraSlippageBps: 25, simulatedLatencySec: 2,
    autoRule: { enabled: false, minScore: 50, minSupport: 3, orderUsd: 250, states: ['New agreement', 'Building'], exitOnEnd: true, maxOpen: 10 },
  },
  discovery: {
    boards: [
      { period: 'month', category: 'overall', limit: 100 },
      { period: 'all', category: 'overall', limit: 100 },
      { period: 'week', category: 'overall', limit: 50 },
    ],
    evaluateTop: 60,
  },
};

function deepMerge<T>(base: T, patch: any): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : patch) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(patch)) {
    if (!(k in (base as any))) continue; // ignore unknown keys
    out[k] = typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k]) ? deepMerge((base as any)[k], patch[k]) : patch[k];
  }
  return out;
}

export function getActiveSettings(db: DB): { version: number; settings: Settings } {
  const row = db.prepare('SELECT id, json FROM settings_versions ORDER BY id DESC LIMIT 1').get() as any;
  if (!row) {
    const id = Number(db.prepare('INSERT INTO settings_versions(created_at,json,note) VALUES(?,?,?)').run(nowSec(), JSON.stringify(DEFAULT_SETTINGS), 'Defaults').lastInsertRowid);
    return { version: id, settings: DEFAULT_SETTINGS };
  }
  // merge onto defaults so newly added keys get defaults
  return { version: row.id, settings: deepMerge(DEFAULT_SETTINGS, JSON.parse(row.json)) };
}

export function updateSettings(db: DB, patch: any, note?: string) {
  const cur = getActiveSettings(db).settings;
  const next = deepMerge(cur, patch);
  if (JSON.stringify(next) === JSON.stringify(cur)) return getActiveSettings(db);
  db.prepare('INSERT INTO settings_versions(created_at,json,note) VALUES(?,?,?)').run(nowSec(), JSON.stringify(next), note || 'Updated');
  return getActiveSettings(db);
}

export function snapshotWatchlist(db: DB, reason: string) {
  const addrs = (db.prepare('SELECT address FROM wallets WHERE followed=1 ORDER BY address').all() as any[]).map((r) => r.address);
  const last = db.prepare('SELECT id, addresses FROM watchlist_versions ORDER BY id DESC LIMIT 1').get() as any;
  if (last && last.addresses === JSON.stringify(addrs)) return last.id as number;
  return Number(db.prepare('INSERT INTO watchlist_versions(created_at,addresses,reason) VALUES(?,?,?)').run(nowSec(), JSON.stringify(addrs), reason).lastInsertRowid);
}
export const currentWatchlistVersion = (db: DB) => ((db.prepare('SELECT id FROM watchlist_versions ORDER BY id DESC LIMIT 1').get() as any)?.id ?? null) as number | null;
