/**
 * Signal lifecycle. A "signal" is a consensus result (exact token) persisted over time so we can say when it was
 * first observed and whether it is strengthening.
 *
 * State rules (evaluated in this priority order):
 *  1. Stale      — quote missing/older than quoteStaleSec, or < 50% of followed wallets refreshed.
 *  2. Weakening  — vs the snapshot ~trendLookbackSec ago: fewer supporters, OR supporting value down by
 *                  >= changeExposurePct, OR >= exitMinWallets supporters reduced/exited in the recent window.
 *  3. New agreement — first detected within newWindowSec AND not detected during the startup baseline.
 *  4. Building   — more supporters than the lookback snapshot, OR supporting value up >= changeExposurePct with
 *                  net inflow in the window.
 *  5. Stable     — none of the above.
 *  Ended        — support fell below minSupport (signal closed, kept for history).
 */
import type { DB } from '../db.js';
import type { Settings } from '../settings.js';
import type { ConsensusResult } from './consensus.js';
import { emitAlert } from './alerts.js';

export type SignalState = 'Stale' | 'Weakening' | 'New agreement' | 'Building' | 'Stable' | 'Ended';

export interface Past { support: number; supportValue: number | null; ts: number }

export function decideState(r: ConsensusResult, sig: { firstDetectedAt: number; baseline: boolean }, past: Past | null, now: number, S: Settings): { state: SignalState; reasons: string[] } {
  const c = S.consensus;
  const reasons: string[] = [];
  const quoteStale = !r.quote || r.quote.ageSec > c.quoteStaleSec;
  if (quoteStale || r.dataQuality.coverage < 0.5) {
    if (quoteStale) reasons.push(r.quote ? `Quote ${Math.round(r.quote.ageSec / 60)} min old (limit ${Math.round(c.quoteStaleSec / 60)}).` : 'No quote.');
    if (r.dataQuality.coverage < 0.5) reasons.push(`Only ${Math.round(r.dataQuality.coverage * 100)}% of followed wallets refreshed.`);
    return { state: 'Stale', reasons };
  }
  const reducers = r.flows.liveReducingUnits;
  if (past) {
    if (r.supportCount < past.support) reasons.push(`Supporters fell ${past.support} → ${r.supportCount}.`);
    if (past.supportValue && r.supportValue !== null && r.supportValue < past.supportValue * (1 - c.changeExposurePct)) reasons.push(`Supporting value down ${Math.round((1 - r.supportValue / past.supportValue) * 100)}%.`);
  }
  if (reducers.length >= S.alerts.exitMinWallets) reasons.push(`${reducers.length} supporters reduced or exited in the window.`);
  if (reasons.length) return { state: 'Weakening', reasons };
  if (!sig.baseline && now - sig.firstDetectedAt <= c.newWindowSec) return { state: 'New agreement', reasons: [`First observed ${Math.round((now - sig.firstDetectedAt) / 60)} min ago.`] };
  if (past) {
    if (r.supportCount > past.support) return { state: 'Building', reasons: [`Supporters rose ${past.support} → ${r.supportCount}.`] };
    if (past.supportValue && r.supportValue !== null && r.supportValue > past.supportValue * (1 + c.changeExposurePct) && r.flows.inflowUsd > r.flows.outflowUsd)
      return { state: 'Building', reasons: [`Supporting value up ${Math.round((r.supportValue / past.supportValue - 1) * 100)}% with net inflow.`] };
  }
  return { state: 'Stable', reasons: ['No meaningful change versus the lookback snapshot.'] };
}

/** Persist results as signals, update states, write snapshots and fire alerts. `baselineRun` suppresses alerts. */
export function updateSignals(db: DB, results: ConsensusResult[], now: number, S: Settings, settingsVersion: number, baselineRun: boolean, recentlyAdded: Set<string> = new Set()) {
  const active = new Map<string, any>((db.prepare('SELECT * FROM signals WHERE ended_at IS NULL').all() as any[]).map((r) => [r.token_id, r]));
  const seen = new Set<string>();
  const A = S.alerts;
  const out: { tokenId: string; signalId: number; state: SignalState; reasons: string[] }[] = [];

  for (const r of results) {
    seen.add(r.tokenId);
    let sig = active.get(r.tokenId);
    const mid = r.quote?.mid ?? null;
    if (!sig) {
      // A signal that only exists because a wallet was just added to the watchlist reflects pre-existing positions:
      // treat it as baseline (no "New agreement" state, no alert).
      const viaWatchlist = r.supporters.some((u) => u.wallets.some((w) => recentlyAdded.has(w.address)));
      const isBase = baselineRun || viaWatchlist;
      const id = Number(db.prepare(`INSERT INTO signals(token_id,condition_id,first_detected_at,first_price,first_support,last_change_at,last_computed_at,state,support,oppose,support_value,score,peak_support,settings_version,baseline)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.tokenId, r.conditionId, now, mid, r.supportCount, now, now, 'New agreement', r.supportCount, r.opposeCount, r.supportValue, r.score.total, r.supportCount, settingsVersion, isBase ? 1 : 0).lastInsertRowid);
      sig = db.prepare('SELECT * FROM signals WHERE id=?').get(id);
      if (!isBase && r.supportCount >= A.convergenceMinSupport) {
        emitAlert(db, { now, kind: 'convergence', key: `conv:${r.tokenId}`, severity: 'info', cooldownSec: A.cooldownSec,
          title: `${r.supportCount} wallets converge on “${r.outcome}” — ${r.title}`,
          body: `${r.supportCount} independent followed wallets/clusters now hold net ${r.outcome}. Opposing: ${r.opposeCount}. Score ${r.score.total.toFixed(0)} (not a probability).`,
          data: { tokenId: r.tokenId, conditionId: r.conditionId, signalId: id } });
      }
    }
    if (sig.first_price === null && mid !== null) db.prepare('UPDATE signals SET first_price=? WHERE id=?').run(mid, sig.id); // first observed quote

    // lookback snapshot: latest at or before now - lookback, else earliest
    const past = (db.prepare('SELECT * FROM signal_snapshots WHERE signal_id=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(sig.id, now - S.consensus.trendLookbackSec)
      ?? db.prepare('SELECT * FROM signal_snapshots WHERE signal_id=? ORDER BY ts ASC LIMIT 1').get(sig.id)) as any;
    const pastV: Past | null = past ? { support: past.support, supportValue: past.support_value, ts: past.ts } : null;
    const { state, reasons } = decideState(r, { firstDetectedAt: sig.first_detected_at, baseline: !!sig.baseline }, pastV, now, S);

    // threshold-crossing alerts (only for already-known signals; never during baseline)
    const watchlistDriven = r.supporters.some((u) => u.wallets.some((w) => recentlyAdded.has(w.address)));
    if (!baselineRun && !watchlistDriven) {
      const prevSupport = sig.support as number;
      if (prevSupport < A.convergenceMinSupport && r.supportCount >= A.convergenceMinSupport) {
        emitAlert(db, { now, kind: 'convergence', key: `conv:${r.tokenId}`, severity: 'info', cooldownSec: A.cooldownSec,
          title: `${r.supportCount} wallets converge on “${r.outcome}” — ${r.title}`, body: `Support crossed ${A.convergenceMinSupport} (was ${prevSupport}). Score ${r.score.total.toFixed(0)}.`, data: { tokenId: r.tokenId, signalId: sig.id } });
      }
      if (pastV && r.supportCount - pastV.support >= A.increaseMinDelta) {
        emitAlert(db, { now, kind: 'increase', key: `inc:${r.tokenId}`, severity: 'info', cooldownSec: A.cooldownSec,
          title: `Agreement increasing on “${r.outcome}” — ${r.title}`, body: `Supporters ${pastV.support} → ${r.supportCount} since ${new Date(pastV.ts * 1000).toISOString()}.`, data: { tokenId: r.tokenId, signalId: sig.id } });
      }
    }
    const changed = sig.support !== r.supportCount || sig.state !== state || sig.oppose !== r.opposeCount;
    db.prepare(`UPDATE signals SET last_computed_at=?, state=?, support=?, oppose=?, support_value=?, score=?, peak_support=MAX(peak_support,?), last_change_at=CASE WHEN ? THEN ? ELSE last_change_at END, last_result=? WHERE id=?`)
      .run(now, state, r.supportCount, r.opposeCount, r.supportValue, r.score.total, r.supportCount, changed ? 1 : 0, now, JSON.stringify({ reasons }), sig.id);
    const lastSnap = db.prepare('SELECT * FROM signal_snapshots WHERE signal_id=? ORDER BY ts DESC LIMIT 1').get(sig.id) as any;
    if (!lastSnap || changed || now - lastSnap.ts >= 900 || Math.abs((lastSnap.support_value ?? 0) - (r.supportValue ?? 0)) > (lastSnap.support_value ?? 0) * 0.05) {
      db.prepare('INSERT INTO signal_snapshots(signal_id,ts,support,oppose,support_value,oppose_value,mid,score,supporters) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(sig.id, now, r.supportCount, r.opposeCount, r.supportValue, r.opposeValue, mid, r.score.total, JSON.stringify(r.supporters.map((u) => u.id)));
    }
    out.push({ tokenId: r.tokenId, signalId: sig.id, state, reasons });
  }

  // signals that lost consensus
  for (const [tok, sig] of active) {
    if (seen.has(tok)) continue;
    db.prepare("UPDATE signals SET ended_at=?, state='Ended', last_change_at=?, last_computed_at=? WHERE id=?").run(now, now, now, sig.id);
    db.prepare('INSERT INTO signal_snapshots(signal_id,ts,support,oppose,support_value,oppose_value,mid,score,supporters) VALUES(?,?,?,?,?,?,?,?,?)').run(sig.id, now, 0, 0, 0, null, null, 0, '[]');
    if (!baselineRun) {
      // count live (non-baseline) reductions/exits among wallets in this signal over the window
      const since = now - S.consensus.recentWindowSec;
      const rows = db.prepare('SELECT DISTINCT wallet FROM position_changes WHERE token_id=? AND ts>=? AND is_baseline=0 AND new_size < prev_size*(1-?)').all(tok, since, A.exitReducePct) as any[];
      if (rows.length >= A.exitMinWallets) {
        const title = (db.prepare('SELECT title FROM positions WHERE token_id=? LIMIT 1').get(tok) as any)?.title ?? sig.condition_id;
        emitAlert(db, { now, kind: 'exit', key: `exit:${tok}`, severity: 'warning', cooldownSec: A.cooldownSec,
          title: `Consensus ended — ${rows.length} supporters reduced/exited`, body: `${title}: support fell below ${S.consensus.minSupport}.`, data: { tokenId: tok, signalId: sig.id, wallets: rows.map((r) => r.wallet) } });
      }
    }
  }

  // exits on still-active signals
  if (!baselineRun) for (const r of results) {
    const reducers = r.flows.liveReducingUnits.length; // live only: backfilled history never alerts
    if (reducers >= A.exitMinWallets) {
      const sid = out.find((o) => o.tokenId === r.tokenId)?.signalId;
      emitAlert(db, { now, kind: 'exit', key: `exit:${r.tokenId}`, severity: 'warning', cooldownSec: A.cooldownSec,
        title: `${reducers} wallets reducing “${r.outcome}” — ${r.title}`, body: `Exited: ${r.flows.exitedUnits.length}. Reducing: ${r.flows.reducingUnits.length}. Remaining supporters: ${r.supportCount}.`, data: { tokenId: r.tokenId, signalId: sid } });
    }
  }
  return out;
}
