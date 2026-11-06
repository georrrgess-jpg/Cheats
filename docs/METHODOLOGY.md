# Methodology

All tracking, scoring and consensus calculations are deterministic code (`server/src/core/*`), unit-tested, and use no
LLM. Every threshold below is configurable in **Settings**; saving creates a new immutable settings version.
Defaults are shown in brackets. `null` / *Unavailable* always means "not observable" — never zero.

## 1. Wallet evaluation (`core/scoring.ts`)

### Inputs (per wallet)
| Input | Source | Notes |
|---|---|---|
| Closed positions | `/v2/positions?status=CLOSED&sort_by=TIMESTAMP` | Most-recent-first, capped at `closedSampleMax` [1000]. **Never sorted by PnL** (the provider default), which would sample only winners. |
| Resolved-unredeemed positions | `/v2/positions` OPEN rows with `redeemable=true` | Polymarket keeps resolved **losers** here; ignoring them inflates win rate. |
| PnL series | `/v2/user-pnl?interval=all&fidelity=1d` → `position_pnl` | Cumulative realized + unrealized (marked) trading PnL. |
| Profile stats | `/v2/user-stats` | Provider-reported; shown separately. |
| Categories | Gamma market tags for the 200 largest-|PnL| resolved positions | Others counted as *Unclassified*. |

### Definitions (our calculations)
* **Resolved/exited position** = CLOSED row, or OPEN row flagged `redeemable`. PnL = realized (closed) or realized + unrealized at settlement price (redeemable).
* **Win rate** = share of resolved/exited positions with PnL > 0 (net of attributed fees). Always shown with the sample size. Note: buying at 95¢ wins often and loses big — win rate alone is not skill.
* **Realized ROI** = Σ PnL ÷ Σ cost basis, cost basis = average entry price × total shares bought. It is a *per-position return on capital deployed*, **not** a portfolio return — deposits/balances are not observable, so no portfolio return is reported.
* **Realized by period** (30/90/365 d): positions whose last event falls in the period. If the sample is truncated and does not reach back to the period start, the period is **Unavailable** (not zero).
* **Max drawdown** = largest peak-to-trough fall of the cumulative marked PnL series, in USD.
* **30-day periods** = consecutive 30-day steps back from the latest point (max 24); positive if PnL rose.
* **Concentration** = largest single winning position ÷ gross profit (sum of winning PnL); also top-3 share.

Provider-reported figures (leaderboard PnL, all-time PnL, volume) are labelled as such. Leaderboard week/month PnL is
marked equity change (moves with unrealized prices); all-time is realized only; volume is in shares and never treated as profit.

### Quality score (0–100)
`score = 100 × Σ wₖ·cₖ / Σ wₖ`, components cₖ ∈ [0, 1]:

| Component | Weight | Formula |
|---|---|---|
| Consistency | 0.30 | (positive periods + 1) / (periods + 2) — Bayesian-shrunk; **Unavailable (0)** if < 3 periods |
| Edge | 0.15 | 0 if ROI ≤ 0, else min(1, ROI / `edgeFullRoi` [25%]) |
| Sample size | 0.20 | min(1, ln(1+n) / ln(1+`fullSampleResolved` [100])) |
| Recency | 0.10 | 1 if last activity ≤ 7 d, linear to 0 at 60 d |
| Diversification | 0.15 | 1 − clamp((top-1 share − 0.15) / 0.6) |
| Data completeness | 0.10 | share of: series ≥ 60 d; sample complete or ≥ 200; stats available; open positions available |

An unavailable component scores 0 **and is shown as Unavailable with the reason** — it never silently borrows a value.

### Flags
`SMALL_SAMPLE` (< 20 resolved) · `ONE_BIG_WIN` (top-1 ≥ 50% of gross profit) · `SHORT_HISTORY` (< 60 d series) ·
`TRUNCATED_SAMPLE` · `NEGATIVE_EDGE` · `RECENT_LOSSES` (30-d realized < 0) · `INACTIVE` (> 30 d) ·
`POSSIBLE_MARKET_MAKER` (> 300 fills per market, or maker rebates > 20% of PnL — *uncertain*) ·
`TWO_SIDED` (holds both outcomes in ≥ 3 live markets — possible hedging/market making, *uncertain*).

## 2. Activity tracking (`worker/activitySync.ts`, `worker/positionSync.ts`)
* **Activity** is polled per wallet every 60 s from `/v2/activity`. The first load walks **newest-first** over the
  backfill window [30 d] up to 5,000 events; if capped, coverage is recorded as starting at the oldest fetched event.
  Later polls walk **forward** from the stored cursor (inclusive), so restarts resume and backfill gaps.
* **Deduplication**: rows have no provider id; the key is a hash of wallet, time, type, tx, condition, token, side,
  size, notional and price, plus an ordinal for genuinely identical fills in one transaction. Inserts are idempotent.
* **History vs live**: rows from the initial load, or observed more than `liveObservationLagSec` [15 min] after they
  happened (downtime recovery), are *history* — displayed, never alerted.
* **Meaning of types**: only `TRADE` rows are directional flows. `SPLIT`, `MERGE`, `CONVERSION`, `REDEEM`, transfers,
  rewards and rebates are labelled by meaning and are not counted as new bets.
* **Reconciliation**: every 3 min the wallet's full open-position list replaces the stored set atomically; each size
  change is logged. Exits disappear because the provider stops returning them. Changes seen on the first sync or after
  a gap > 2 × stale threshold are *baseline* (no alerts).

## 3. Consensus (`core/consensus.ts`)
1. **Eligible wallets**: followed, positions refreshed within `staleAfterSec` [15 min], quality ≥ `minQualityScore` [0].
   Stale wallets are excluded from counts *and* the denominator and listed separately.
2. **Live positions only**: resolved/redeemable rows and closed markets are excluded.
3. **Net exposure** per wallet per binary market: shares(outcome) − shares(complement). A YES+NO pair is worth $1
   regardless of outcome, so it is not a view. Holdings under `minPositionUsd` [$100] are dust.
4. **Units**: wallets with the same declared *cluster* merge into one unit. Wallets whose live holdings overlap with
   Jaccard ≥ `linkJaccard` [0.8] (both ≥ 5 holdings) are *suspected links*; with `collapseSuspectedLinks` [on] they also
   count once. This is a conservative counting assumption, not a claim of shared ownership.
5. **Result** for each outcome token with ≥ `minSupport` [2] supporting units. Opposition = units net-long the
   complement. In multi-outcome (neg-risk) events, holders of *other* outcomes are listed but not counted as opposition.
6. **Recent flows** in the selected window: buying the outcome or selling the complement = inflow; selling the outcome
   or buying the complement = outflow (trades only). Reductions/exits also come from reconciled position changes.

### Consensus score (0–100, not a probability)
`score = 100 × Σ wₖ·cₖ / Σ wₖ`

| Component | Weight | Formula |
|---|---|---|
| Breadth | 0.35 | min(1, supporters / `breadthTarget` [5]) |
| Quality | 0.25 | (capped quality-weighted support share vs opposition) × mean supporter quality / 100 |
| Exposure | 0.25 | capped USD exposure share of support vs opposition |
| Momentum | 0.15 | 0.5 + 0.5 × (inflow − outflow) / (inflow + outflow); 0.5 when no trades |

**Influence cap**: no unit may exceed `maxInfluenceShare` [35%] of quality or exposure weight (iterative water-filling;
if the cap is infeasible because there are too few units, weights become equal). Wallets not yet evaluated use a
disclosed neutral quality of 50.

**Data quality** (separate from the score): *High* = ≥ 90% coverage, fresh quote with asks, metadata loaded, ≥ 90% of
supporter shares with entry prices; *Medium* = ≥ 60% coverage and a quote; otherwise *Low*. Issues are listed.

### Signal states
Evaluated in priority order against the snapshot nearest to `trendLookbackSec` [24 h] ago:
1. **Stale** — quote missing or older than `quoteStaleSec` [10 min], or < 50% of followed wallets refreshed.
2. **Weakening** — fewer supporters; or supporting value down ≥ `changeExposurePct` [20%]; or ≥ `exitMinWallets` [2] supporters reduced/exited live in the window.
3. **New agreement** — first observed within `newWindowSec` [6 h], and not part of the startup baseline or a watchlist addition.
4. **Building** — more supporters; or value up ≥ 20% with net inflow.
5. **Stable** — otherwise. **Ended** — support fell below the minimum (kept for history).

*Price since first seen* uses the mid at first detection. *Est. entry* is the share-weighted provider average cost of
current supporters (coverage shown); it is not a price you could have obtained.

## 4. Alerts (`core/signals.ts`, `core/alerts.ts`)
| Alert | Rule |
|---|---|
| Convergence | support crosses `convergenceMinSupport` [3] upward (or a new signal starts at/above it) |
| Agreement increase | supporters up ≥ `increaseMinDelta` [2] vs lookback |
| Exits | ≥ `exitMinWallets` [2] supporters reduced by ≥ `exitReducePct` [50%] or exited, **live** only |
| Stale / failure | provider ≥ 3 consecutive failures; ≥ 30% of wallets stale |

Each alert key has a cooldown [6 h; 1 h for health]. The first computation on a new database is a baseline, and
signals created only because a wallet was just followed are marked *pre-existing*: neither fires alerts.

## 5. Paper trading (`core/paper.ts`)
* **Forward only.** Orders are recorded at decision time with the signal snapshot, settings version and watchlist version.
* **Fill** uses an order book **fetched after** `simulatedLatencySec` [2 s] has elapsed — never a cached earlier quote,
  never a whale's entry price. Buys walk asks up to best ask × (1 + `maxSlippagePct` [5%]); each level is worsened by
  `extraSlippageBps` [25 bps]; taker fee = shares × rate × p(1−p) using the market's fee schedule (category default,
  labelled, if unknown). Results: *filled*, *partial*, or *unfilled*. All fills are labelled estimates because
  historical/queue-level books are not available.
* **Valuation**: liquidation value at best bids. **Settlement** only when a market is closed and its outcome price is exactly 0 or 1.
* **Auto rule** (optional): buys when a signal is in configured states with score/support thresholds; exits when the signal ends.
* **No backtest**: selecting today's best wallets and replaying their past would use hindsight (look-ahead bias), and no
  historical order books exist to fill against. Forward tracking is the defensible alternative.
