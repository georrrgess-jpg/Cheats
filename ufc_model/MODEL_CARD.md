# MODEL CARD: UFC fight model

## Data
UFCStats fight, round and fighter data (Greco1899 public scrape), 1994 → 2026-10-31: 8,976 fights, 42k fight-rounds. Rates use 2010+ standard-format fights. League constants come from the 2020+ era. Odds come from BestFightOdds (7 books tonight) plus manual entry.

## Design
1. **Features:** a chronological as-of pass with opponent-adjusted, 600-day-half-life, empirical-Bayes-shrunk per-minute rates (standing and ground striking, TD attempts and accuracy, control per TD, sub attempts, KD per head strike landed and absorbed), cardio, durability, age, reach, layoff, Elo.
2. **Win model:** L2 logistic regression (C=0.05) on antisymmetric differences, no intercept (symmetric by construction), temperature-calibrated. Blended out of fold with HistGradientBoosting (weight 0.3) when `ensemble: true`.
3. **Simulator:** 30-second steps, standing / A-top / B-top, Poisson strikes with per-fighter lognormal form (σ≈0.33), shared pace, grappling form (σ≈1.6, which creates takedown overdispersion), knockdowns, damage, competing KO/SUB/doctor hazards with a fighter finish-propensity term (α=0.5), fight-level judging model.
   - Calibrated by simulated method of moments on the latest 18 months, plus a 5-round scalar.
   - Tilted per bout so P(A) matches the moneyline `p_final`.
4. **Pricing:**
   - Every market is priced from the joint sims, then devigged (power for 2-way, Shin for multi-way) against the median consensus across books.
   - Probabilities are logit-shrunk toward the market: weight 0.30 for ML, 0.40 for method, distance and rounds, 0.60 for sig strikes and takedowns, scaled down further on the main card and main event.
   - Bootstrap P(EV>0), filters, correlation control, quarter Kelly with caps.

## Validation (see BACKTEST.md)
- Win model walk-forward 2022→: log loss 0.646 (Elo 0.681, coin 0.693). On the 6-month hold-out: 0.658. Sharp closing lines are typically about 0.60–0.62, so the model sits behind the market on moneylines.
- Simulator: reproduces method, round, strike, control and takedown base rates on the calibration window. See BACKTEST.md for the hold-out reliability of distance, rounds, takedown and sig-strike props.
- No historical odds were available, so ROI and CLV are unmeasured.

## Known weaknesses
- **Debutants and one-fight fighters:** priors only, no pre-UFC records (Sherdog/Tapology not integrated). This is where the market knows much more.
- **Heavyweight volatility and 5-round fights:** few 5-round bouts (one shared 5-round hazard scalar). The HW 5-rounder finish rate is likely understated.
- **Women's divisions:** smaller samples. Separate weight-group scales are used.
- **Judging:** fight-level, not round-level (no scorecard source reachable).
- **Position time** is approximated from control time.
- **Era drift:** finish rates rose in 2026. The simulator uses an 18-month window, so it can lag shifts.
