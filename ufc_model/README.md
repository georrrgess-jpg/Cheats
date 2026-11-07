# UFC betting model

Calibrated probabilities for every bout and market on a UFC card, compared with vig-free sportsbook prices, ending in a ranked best-bet list with stakes. Built for UFC Vegas 124 (Nov 7 2026), but event-agnostic (`--event`).

> These are probability estimates, not guarantees. Stakes are suggestions inside the configured bankroll caps.

## Setup
```bash
cd ufc_model
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```
Optional: put `ODDS_API_KEY=...` in `.env` (gitignored). The pipeline runs without it: BestFightOdds + `data/odds_input.csv`.

## Commands
| Command | What it does |
|---|---|
| `python run_tonight.py --event "UFC Vegas 124"` | Full pipeline: data → features → win model → simulator → markets → odds → edges → best bets → outputs (~2–4 min) |
| `python run_tonight.py --event "UFC Vegas 124" --odds-only` | Re-pull odds, re-rank from cached sims (< 1 min) |
| `python run_tonight.py --event "UFC Vegas 124" --exclude-bout Lorenco-Petersen` | Scratch a bout (persists for later runs), void its bets, re-stake |
| `python run_tonight.py ... --release R1` | Label the run (shows in the picks log) |
| `python parse_paste.py paste.txt` | Parse a raw sportsbook paste into `data/odds_input.csv` |
| `python backtest.py [--reduced] [--gb]` | Walk-forward evaluation; writes `BACKTEST.md` |
| `python watch_odds.py --event "UFC Vegas 124" --every 12` | Snapshot odds until each bout starts (closing lines) |
| `python grade_results.py --event "UFC Vegas 124"` | Grade logged bets, P&L, CLV, write `output/review_<event>.md` |
| `pytest -q` | Tests |

New card: add an entry under `events:` in `config.yaml` (card file, date, BestFightOdds URLs) and a card CSV in `data/cards/` (see `src/scrape_card.py: build_card` to build one from ESPN + Wikipedia).

## Outputs
- `output/<Event>_model.xlsx`: **Best Bets** (first sheet), **Price Targets** (fair odds and the minimum price to bet, for every market, with no odds needed), Card Overview, Moneyline, Method, Rounds, Sig Strikes, Takedowns, Other Props, Fighter Profiles, Sim Distributions, Line Movement, Data Quality, Backtest Summary.
- `output/report.md`: per-bout breakdown, best bets, pass list, biggest disagreements, caveats.
- `output/handoff_summary.md`: < 60 lines, paste-ready for review in a Claude chat.
- `output/predictions.json`: everything, machine-readable. `data/picks_log.csv`: every recommended bet (fill in `placed_odds`).
- `output/card_verification.md`, `output/data_quality.md`, `output/base_rates.xlsx`, `output/runs/<run_id>/`.

## Glossary
- **Implied probability:** 1 / decimal odds (vig included).
- **Fair probability (`p_fair`):** implied probability with the vig removed. Power method for 2-way, Shin for multi-way; consensus = median across books.
- **Model probability (`p_model`):** the model's raw probability. **`p_final`:** `logit(p_final) = w·logit(p_model) + (1−w)·logit(p_fair)`, with `w` set per market in `config.yaml: shrink`.
- **Edge:** `p_final − p_fair`. **EV per $1:** `p_final × (decimal − 1) − (1 − p_final − p_push)`.
- **P(EV>0):** share of bootstrap draws (parameter uncertainty) in which the bet is +EV at the current price.
- **CLV:** how much better your price is than the closing price, in vig-free probability.
- **Calibration:** outcomes happen at the predicted rates.
- **Units:** probabilities 0–1 internally, % in reports; American odds for display, decimal for math; seconds internally. Fight time: round r at m:ss = (r−1)×300 + 60m + ss.
- **Half-round lines:** O/U 1.5 = 2:30 of R2 (450 s), 2.5 = 750 s, 3.5 = 1,050 s, 4.5 = 1,350 s. A finish at exactly 2:30 grades as over (configurable per book).

## Market codes
`ML`, `METHOD` (`Fighter:KO|SUB|DEC`), `METHOD3`, `ITD`, `DIST`, `ROUND` (`Fighter:R2` / `DEC`), `ROUNDS_OU`, `START_RD`, `END_RD`, `TIME_OU`, `SIG_OU` (`Fighter:OVER`), `SIG_TOT_OU`, `TD_OU`, `KD`, `DEC_TYPE`, `MOST_SIG`, `MOST_TD`, `ROUND_GRP`, `RD_METHOD`, `DRAW`, `FANTASY_OU` (not yet priced). Internal probability keys are documented in `src/markets.py`; prefix `NOT:` = the other side of a yes/no prop.

`data/odds_input.csv` columns: `bout, market, selection, line, american_odds, book, timestamp` (lines starting with `#` are ignored; bout = `LastA-LastB` or any text with both last names).

## How it works (one paragraph per stage)
1. **Data:** UFCStats via the maintained Greco1899 public scrape (UFCStats itself serves a bot check), validated (`output/data_quality.md`).
2. **Features (as of fight date):** one chronological pass; opponent-adjusted, time-decayed (600-day half-life), empirical-Bayes-shrunk rates for standing/ground striking, takedowns, control, submissions, knockdown power/chin; cardio, durability, age, reach, layoff, Elo.
3. **Win model:** L2 logistic regression on antisymmetric feature differences (both orientations, no intercept, so it's symmetric), temperature-calibrated on walk-forward out-of-fold predictions.
4. **Simulator:** 20,000 vectorized sims per bout, 30-second steps, standing/ground positions, Poisson strikes with fighter form and shared pace, knockdowns, takedowns, escapes, competing KO/SUB/doctor hazards, fight-level judging model. Calibrated to base rates by simulated method of moments. Tilted so P(A wins) equals the moneyline `p_final`.
5. **Markets → edges:** every market priced from the joint sims. Odds devigged, consensus fair price, shrinkage, edge, EV, bootstrap P(EV>0), red flags, correlation control, quarter Kelly with caps.
