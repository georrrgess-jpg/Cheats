# WhaleSignal

Follow 10–50 prediction-market wallets with credible track records, reconcile what they actually hold, and see —
with evidence — where several of them hold the **same side of the same outcome**. Evaluate those signals honestly
with forward paper trading before risking real money.

* **Platform:** Polymarket (public, free, no API key). The data layer is modular (`server/src/providers/`) so another venue can be added later.
* **Read-only:** no wallet connection, no private keys, no real orders. Links go to the underlying markets.
* **Consensus is an analytical signal, not a probability, a guaranteed edge, or proof a trade is safe.**

---

## 1. Install and start (about 5 minutes)

You need **Node.js 20.10 or newer** (22 LTS recommended). Download it from <https://nodejs.org> and install with default options.
Check it in a terminal (macOS: *Terminal*; Windows: *PowerShell*; ChromeOS: *Linux development environment*):

```bash
node -v
```

Then, in the WhaleSignal folder:

```bash
npm install
```

```bash
npm start
```

Open **http://127.0.0.1:8787** in your browser.

`npm start` builds the dashboard and starts one process that serves the UI **and** runs the background tracker.

> **Continuous tracking only happens while that terminal window stays open.** If you close it, put the computer to sleep,
> or shut it down, tracking pauses. When you start it again, WhaleSignal resumes from where each wallet left off and
> backfills missed activity (marked as *history* — it never fires alerts as if it just happened).
> For 24/7 tracking, run it on an always-on machine (see [Deployment](docs/DEPLOYMENT.md)).

Stop it with `Ctrl+C`. Your data lives in `data/whalesignal.db` (a single SQLite file — back it up by copying it).

### Optional configuration
Copy `.env.example` to `.env` to change the port, database path, request rate, or set a dashboard password.
No secrets are required. Keep `HOST=127.0.0.1` (private to your computer) unless you set `DASHBOARD_PASSWORD`.

### Demo mode (offline preview)
```bash
npm run demo
```
Runs with synthetic data in a **separate** database (`data/whalesignal-DEMO.db`) and a permanent purple *DEMO* banner.
The app never switches to demo data on its own — if Polymarket is unreachable, you see an error and the last stored live data.

### Developer commands
```bash
npm test            # 57 automated tests (fixtures, no network)
npm run typecheck
npm run dev         # API on :8787 + hot-reloading UI on :5173
```

---

## 2. Using it

### Discover and follow wallets (Wallets → Discover)
1. Press **Run discovery**. It reads Polymarket's public PnL leaderboards (month, all-time, week by default) and
   evaluates the ~60 wallets that appear on the most boards using *their own position history*. Takes a few minutes.
2. Sort **By quality**, tick **Hide wallets with warning flags**, and open a wallet to see *why* it scored as it did.
3. Prefer wallets with: hundreds of resolved positions, a positive realized ROI, mostly positive 30-day periods,
   recent activity, and no single win dominating profit. Be wary of `small sample`, `one big win`, `short history`.
   `possible MM` / `two-sided` wallets may hold inventory rather than views.
4. Press **Follow**. You can also paste any address on the Watchlist tab (use the Polymarket *proxy wallet* address
   from the profile URL). Add a **cluster** name to wallets you believe share an owner — they then count as one supporter.

Coverage: discovery only sees wallets on the boards it reads. It does not find every profitable wallet.

### Read consensus (Consensus)
Each row is an exact outcome token (e.g. *“No” on market X*) held, net, by at least *N* independent followed wallets.
Expand a row to see every supporter and opponent, their size and average entry, the score components, recent
inflows/outflows, data-quality issues, and interpretation notes. Key things to check:

| Column | Meaning |
|---|---|
| **State** | *New agreement*, *Building*, *Stable*, *Weakening*, *Stale* (rules in [methodology](docs/METHODOLOGY.md#signal-states)). *pre-existing* = already present when tracking began. |
| **x of y refreshed units** | Supporters relative to wallets whose positions were refreshed recently. Stale wallets are excluded, not assumed. |
| **Ask · spread** | What buying would cost now, from the live order book. |
| **Since first seen** | Mid-price change since WhaleSignal first observed this agreement. |
| **Est. entry** | Supporters' provider-reported average cost. You **cannot** get their earlier price. |
| **Score** | 0–100 agreement-strength ranking with visible components. **Not a probability.** |
| **Data: High/Medium/Low** | Separate from the score: coverage, quote freshness, metadata, entry-price completeness. |

Open **Market detail** for the price chart (with supporters' entry and first-observed price marked), the order book,
supporter count over time, and every reconciled exposure change.

### Paper trade (Paper)
Press **Paper buy** on any result. The decision, the full signal snapshot and the settings version are recorded;
the fill happens against the **next order book fetched after the decision**, with taker fees, depth, and extra
slippage — possibly partial or unfilled. Optionally enable the **automatic forward rule** (Settings → Paper trading →
autoRule.enabled, then tick it on the Paper page) to evaluate a mechanical policy over the coming weeks.

### Alerts
The bell shows in-app alerts for: support crossing the convergence threshold, rising agreement, multiple supporters
reducing/exiting, provider failures, and stale data. Cooldowns and threshold-crossing rules prevent repeats.

---

## 3. Documentation
* [Methodology & formulas](docs/METHODOLOGY.md) — quality score, consensus score, states, alerts, paper fills.
* [Data sources & limitations](docs/DATA_SOURCES.md) — verified endpoints, rate limits, coverage, what is unavailable.
* [Deployment & costs](docs/DEPLOYMENT.md) — running 24/7 and protecting the dashboard.
* [Validation report](docs/VALIDATION.md) — what was tested live vs with fixtures.

## 4. Project layout
```
server/src/
  providers/    polymarket.ts (live API mapping), fixture.ts (tests/demo), types.ts (platform-neutral contracts)
  worker/       scheduler, activity sync, position reconciliation, markets, order books
  core/         consensus (pure), signals/states, alerts, scoring (pure), discovery, paper trading
  api.ts        REST API used by the dashboard
web/src/        React dashboard (Overview, Wallets, Activity, Consensus, Market detail, Paper, Settings)
tests/          vitest suites: consensus, sync/restart/rate limits, signals/alerts, scoring, paper, worker e2e
```
