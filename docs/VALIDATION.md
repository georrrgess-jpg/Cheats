# Validation report (6 Nov 2026)

## Verified LIVE against Polymarket (real network, real wallets)
| Path | Result |
|---|---|
| API access | Data API v2, Gamma, CLOB books all reachable without auth. Data API **v1 and lb-api return HTTP 410 (retired)** — not used. |
| Discovery | 3 leaderboards → 194–195 candidates; 60 evaluated in ≈ 3.5 min; 0 errors, 0 rate-limit responses. |
| Scoring sanity | Wallets with 2–5 resolved positions and one dominant win scored 18–41 with `SMALL_SAMPLE`/`ONE_BIG_WIN`; wallets with 260–3,000 resolved positions scored 87–96. |
| End-to-end path | 20 followed wallets → 72k activity rows (newest-first backfill) → 24k reconciled positions → 93 consensus results → dashboard. Example: 5 independent wallets net "No" on *Will Dan Sullivan win the Alaska Senate race in 2026?* with full evidence. |
| Freshness | 113 live events observed with average trade→observed lag **29 s** (max 84 s). |
| Restart recovery | Server restarted twice on the same DB: cursors resumed, no re-fetch duplicates, baseline produced **0 false alerts**. |
| Dedupe | The only identical-looking rows (13 groups) matched the provider's own count exactly (genuine repeated fills in one tx). |
| Paper trade | Live buy filled across 7 real book levels at 78.15¢ vs 76.4¢ displayed ask, fee at the market's 0.04 rate; after moving fills to a dedicated loop, live fill latency is **3 s** after the decision. |
| Fresh install | `git clone` → `npm install` (13 s) → `npm start` → UI HTTP 200 with tracking on. |
| UI | Every page rendered in Chromium at 1400 px (light + dark) and 390 px (phone), no console errors. |

### Defects found by live testing and fixed
1. Gamma `/markets` omits closed markets unless `closed=true` → resolved positions were "Unclassified". Now retried with `closed=true` (regression test added).
2. Oldest-first initial backfill left very active wallets without recent activity (24 h count was 1). Now newest-first with honest coverage recording (24 h count 14,100).
3. Unprioritized metadata/quote caps left top signals without category or quote. Now prioritized by signal → paper → position value.
4. Unopposed pairs scored highly regardless of wallet quality. Quality component now multiplies by mean supporter quality.
5. Concurrent evaluation on bulk follow; now queued (one per worker cycle).
6. Paper fills waited behind wallet sync (45 s). Now a 2 s loop with an idempotent fill guard.
7. Sub-cent order-book ticks displayed as duplicate prices; US Senate race tagged "Global Elections" mapped to Geopolitics.

## Verified with FIXTURES (automated, `npm test` — 62 tests, no network)
* Duplicate activity, inclusive-cursor overlap, identical fills in one transaction.
* Reconnect/downtime backfill stored as history (never alerts); restart resumes from cursor.
* Newest-first initial load with truncated-coverage recording.
* Partial exit keeps reduced support; full exit removes support; exits below minimum end the signal with an exit alert.
* Opposing outcomes; YES+NO netting; multi-outcome events (other outcomes listed, not opposition).
* Stale and never-synced wallets excluded from support and denominator.
* Resolved/redeemable positions and closed markets excluded; dust threshold.
* Declared clusters and suspected links counted once; influence cap (water-filling) and infeasible-cap fallback.
* Flows: complement buys as outflow, merges non-directional, backfill flagged.
* Missing quote/entry → null + data-quality issue (never zero).
* Signal states (Stale / Weakening / Building / Stable / New agreement), baseline suppression, watchlist-addition suppression, threshold crossing, per-key cooldown.
* Scoring: redeemable losers counted, small-sample and one-big-win flags, Unavailable components, drawdown, truncated periods Unavailable, lucky vs consistent ordering, market-maker wording.
* HTTP: 429 + Retry-After, 5xx/network backoff, no retry on 4xx, request spacing.
* Provider outage: data kept, failures recorded, wallets go stale and drop out, stale alert fires; no demo substitution.
* Paper: book walk with p(1−p) fees, partial/unfilled fills, no fill from a pre-decision quote, latency respected, idempotent fills, cash checks, settings-version recording, settlement only on unambiguous resolution.
* Worker end-to-end: baseline → convergence alert → restart without duplicate alerts → exits end signal.

## Not verified live (and why)
* **Real 429 responses / provider outages**: not induced against the live service (would require abusing it); covered by fixtures.
* **Market resolution settlement** of a live paper position: requires waiting for a market to resolve.
* **Week-long behaviour** (Building/Weakening transitions, alert cadence): requires running for days; logic is unit-tested.

## Remaining blockers
None. No credentials or paid services are required.
