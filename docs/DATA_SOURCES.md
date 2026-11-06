# Data sources (verified November 2026)

All endpoints were inspected in the official docs (<https://docs.polymarket.com>) and called live while building.
**No authentication, API key, or payment is required.** Costs: $0.

| Purpose | Endpoint | Pagination | Notes verified live |
|---|---|---|---|
| Leaderboards | `GET data-api.polymarket.com/v2/leaderboard?time_period=&category=&sort_by=PNL` | opaque cursor | day/week/month/all; finite windows = marked equity change net of flows, `all` = realized only; volume in **shares** |
| Wallet activity | `GET /v2/activity?user=&start=&sort_direction=` | keyset cursor, ≤ 1000/page | TRADE, SPLIT, MERGE, REDEEM, CONVERSION, …; ~3-year default window (`start=1` for full); no row id |
| Positions | `GET /v2/positions?user=&status=OPEN\|CLOSED` | keyset cursor | avg price, realized/unrealized PnL, `first_entry_at`, opposite token; OPEN includes resolved-unredeemed rows (`redeemable`) |
| PnL series | `GET /v2/user-pnl?user=&interval=all&fidelity=1d` | — | cumulative realized / unrealized / rebates; deposits are `null` |
| Profile stats | `GET /v2/user-stats?user=` | — | markets traded, biggest win, all-time composition |
| Freshness | `GET /v2/status` | — | provider ingestion lag (was 2 s when checked) |
| Market metadata | `GET gamma-api.polymarket.com/markets?condition_ids=…&include_tag=true` | ≥ 100 ids/call | outcomes, token ids, tags, `closed`, `negRisk`, `feeSchedule {rate, exponent, takerOnly}`, liquidity |
| Order books | `POST clob.polymarket.com/books` `[{token_id}]` | ≥ 300 tokens/call | live depth + timestamp |
| Price history | `GET /v2/prices-history?token_id=&interval=1m` | cursor | used for the market chart |

**Retired (HTTP 410), do not use:** Data API v1 (`/positions`, `/trades`, `/v1/leaderboard`) and `lb-api.polymarket.com`.

## Rate limits (documented, IP-based, Cloudflare throttling)
Data API v2: 800 req / 10 s overall; `/v2/positions` and `/v2/activity` 200 / 10 s. Gamma `/markets` 300 / 10 s.
CLOB `/books` 500 / 10 s. A `429` carries `Retry-After`. WhaleSignal self-limits to **4 requests/second per host**
(`REQUESTS_PER_SECOND`), retries 429/5xx/network errors with exponential backoff + jitter (honouring `Retry-After`),
and does not retry other 4xx.

## Streaming
The public market WebSocket carries order-book and price events **only — it does not identify wallets**. There is no
public wallet-attributed trade stream, so wallet tracking uses rate-limited polling (every 60 s activity, 3 min positions).
Order books are polled (60 s) because polling the ≤ 2,000 relevant tokens is cheap and simpler than a socket.
The UI shows measured freshness ("positions 40 s ago", average trade→observed lag) rather than promising real time.

## Expected freshness
Provider ingestion lag is seconds. With defaults and 20–50 wallets, a new trade is typically observed within ~1–2
minutes and reflected in reconciled positions within ~3–4 minutes. Heavy wallets with thousands of open positions take
longer per cycle; the per-wallet sync time is displayed.

## Known limitations
* **Discovery coverage** is limited to the leaderboard boards read (default top 100 month, top 100 all-time, top 50 week).
* **Deposits/balances are not observable**, so portfolio returns are Unavailable; ROI is per-position on cost basis.
* **Closed-position samples** are capped (1,000 most recent); very active wallets may cover < 90 days → longer periods Unavailable.
* **Entry prices** come from the provider's average cost; positions received via split/transfer may lack a price.
* **No historical order books** → paper fills are estimates against live books; no backtest.
* **Linked wallets** cannot be proven from public data; clustering is an explicit, visible assumption.
* **Unobserved exposure** (other wallets, other venues, off-chain hedges) can change what holdings mean.
* Gamma does not return metadata for a small share of markets; those show category *Unknown* and a data-quality issue.
