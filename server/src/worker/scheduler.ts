import type { DB } from '../db.js';
import { getMeta, setMeta } from '../db.js';
import type { MarketDataProvider } from '../providers/types.js';
import type { HttpClient } from '../util/http.js';
import { getActiveSettings } from '../settings.js';
import { nowSec, sleep, DAY } from '../util/time.js';
import { syncWalletActivity } from './activitySync.js';
import { syncWalletPositions } from './positionSync.js';
import { syncMarkets } from './marketSync.js';
import { syncQuotes, tokensToQuote } from './quoteSync.js';
import { runConsensusFromDb } from '../core/consensusService.js';
import { updateSignals } from '../core/signals.js';
import { emitAlert } from '../core/alerts.js';
import { processPendingOrders, runAutoRule, settleResolved } from '../core/paper.js';
import { evaluateAndStore } from '../core/discovery.js';

export interface WorkerStatus {
  startedAt: number; running: boolean; lastTickAt: number | null; lastConsensusAt: number | null; lastQuotesAt: number | null; lastMarketsAt: number | null;
  baselineDone: boolean; lastError: string | null; cycle: number; note: string;
}

export class Worker {
  status: WorkerStatus = { startedAt: nowSec(), running: false, lastTickAt: null, lastConsensusAt: null, lastQuotesAt: null, lastMarketsAt: null, baselineDone: false, lastError: null, cycle: 0, note: '' };
  private stopFlag = false;
  private nextActivity = new Map<string, number>();
  private nextPositions = new Map<string, number>();
  private lastEval = 0;

  constructor(private db: DB, private provider: MarketDataProvider, private http: HttpClient | null) {}

  start() {
    if (this.status.running) return;
    this.status.running = true;
    this.stopFlag = false;
    void this.loop();
    void this.paperLoop();
  }

  /** Paper orders are filled on their own fast loop so a fill is not delayed by long wallet-sync cycles. */
  private async paperLoop() {
    while (!this.stopFlag) {
      try { await processPendingOrders(this.db, this.provider, nowSec()); } catch (e: any) { this.status.lastError = `paper: ${e.message}`; }
      await sleep(2000);
    }
  }
  stop() { this.stopFlag = true; }

  /** Force immediate refresh of one wallet (used after adding it). */
  bump(address: string) { this.nextActivity.set(address, 0); this.nextPositions.set(address, 0); }

  private async loop() {
    while (!this.stopFlag) {
      try { await this.tick(); } catch (e: any) { this.status.lastError = String(e?.message || e); }
      await sleep(5000);
    }
    this.status.running = false;
  }

  async tick(now = nowSec()) {
    const db = this.db;
    const realStart = nowSec();
    const clock = () => now + (nowSec() - realStart); // one consistent clock (injectable for tests)
    const { version, settings: S } = getActiveSettings(db);
    this.status.lastTickAt = now;
    this.status.cycle++;
    const wallets = (db.prepare('SELECT address FROM wallets WHERE followed=1').all() as any[]).map((r) => r.address as string);

    // 1. positions first (authoritative current state), then activity; each is per-wallet and failure-isolated.
    let positionsChanged = false;
    for (const w of wallets) {
      if ((this.nextPositions.get(w) ?? 0) > now) continue;
      try { await syncWalletPositions(db, this.provider, w, S, clock()); positionsChanged = true; this.nextPositions.set(w, now + S.tracking.positionsPollSec); }
      catch { this.nextPositions.set(w, now + Math.min(S.tracking.positionsPollSec, 60)); }
      if (this.stopFlag) return;
    }
    for (const w of wallets) {
      if ((this.nextActivity.get(w) ?? 0) > now) continue;
      try {
        const r = await syncWalletActivity(db, this.provider, w, S, clock());
        this.nextActivity.set(w, r.hasMore ? now : now + S.tracking.activityPollSec); // keep paging a long backfill
      } catch { this.nextActivity.set(w, now + Math.min(S.tracking.activityPollSec, 60)); }
      if (this.stopFlag) return;
    }

    // 2. market metadata
    if (positionsChanged || !this.status.lastMarketsAt || now - this.status.lastMarketsAt > 120) {
      try { await syncMarkets(db, this.provider, S.tracking.marketsRefreshSec, clock()); this.status.lastMarketsAt = clock(); } catch (e: any) { this.status.lastError = `markets: ${e.message}`; }
    }
    // 3. quotes
    if (!this.status.lastQuotesAt || now - this.status.lastQuotesAt >= S.tracking.quotesPollSec || positionsChanged) {
      try { await syncQuotes(db, this.provider, tokensToQuote(db, S.consensus.minPositionUsd)); this.status.lastQuotesAt = clock(); } catch (e: any) { this.status.lastError = `quotes: ${e.message}`; }
    }
    // 4. consensus + signals + alerts. The first run after a fresh database establishes a baseline (no alerts).
    const t = clock();
    const baselineRun = getMeta(db, 'baseline_done') !== '1';
    const allSynced = wallets.length > 0 && wallets.every((w) => (db.prepare('SELECT positions_synced_at FROM wallet_sync WHERE address=?').get(w) as any)?.positions_synced_at);
    if (wallets.length && (!baselineRun || allSynced)) {
      const { results } = runConsensusFromDb(db, S, t);
      const recent = new Set((db.prepare('SELECT address FROM wallets WHERE followed=1 AND added_at >= ?').all(t - 2 * S.tracking.positionsPollSec - 60) as any[]).map((r) => r.address as string));
      const sigs = updateSignals(db, results, t, S, version, baselineRun, recent);
      if (baselineRun) setMeta(db, 'baseline_done', '1');
      this.status.baselineDone = true;
      this.status.lastConsensusAt = t;
      runAutoRule(db, sigs, new Map(results.map((r) => [r.tokenId, r])), t);
    }
    // 5. paper
    try { await processPendingOrders(db, this.provider, clock()); } catch (e: any) { this.status.lastError = `paper: ${e.message}`; }
    settleResolved(db, clock());
    // 6. health
    this.healthChecks(wallets, S, clock());
    // 7. evaluations: wallets never evaluated go first (one per cycle); then daily refresh, spaced >= 60 s.
    const missing = db.prepare(`SELECT w.address FROM wallets w LEFT JOIN wallet_metrics m ON m.address=w.address WHERE w.followed=1 AND m.address IS NULL LIMIT 1`).get() as any;
    const due = missing ?? (now - this.lastEval > 60 ? db.prepare(`SELECT w.address FROM wallets w JOIN wallet_metrics m ON m.address=w.address WHERE w.followed=1 AND m.computed_at < ? ORDER BY m.computed_at LIMIT 1`).get(now - DAY) as any : null);
    if (due) { this.lastEval = now; try { await evaluateAndStore(db, this.provider, due.address); } catch { /* retried next cycle */ } }
  }

  healthChecks(wallets: string[], S: ReturnType<typeof getActiveSettings>['settings'], now: number) {
    const A = S.alerts;
    if (this.http) for (const h of this.http.health.values()) {
      if (h.consecutiveFailures >= A.healthFailureThreshold)
        emitAlert(this.db, { now, kind: 'health', key: `health:${h.host}`, severity: 'critical', cooldownSec: 3600, title: `Provider failing: ${h.host}`, body: `${h.consecutiveFailures} consecutive failures. Last error: ${h.lastError}` });
    }
    if (!wallets.length) return;
    const stale = wallets.filter((w) => {
      const r = this.db.prepare('SELECT positions_synced_at FROM wallet_sync WHERE address=?').get(w) as any;
      return !r?.positions_synced_at || now - r.positions_synced_at > S.tracking.staleAfterSec;
    });
    if (stale.length / wallets.length >= A.staleWalletShare && now - this.status.startedAt > S.tracking.staleAfterSec)
      emitAlert(this.db, { now, kind: 'stale', key: 'stale:wallets', severity: 'warning', cooldownSec: 3600, title: `${stale.length} of ${wallets.length} wallets have stale data`, body: `Position data older than ${Math.round(S.tracking.staleAfterSec / 60)} min. Those wallets are excluded from consensus counts until refreshed.` });
  }
}
