# CHANGELOG

## 2026-11-07
- Initial build for UFC Vegas 124 (data, features, Elo + logistic win model, calibrated simulator, markets, devig, BestFightOdds intake, ranking, staking, reports, tests, backtest).
- Sim calibration: added fighter finish-propensity term (alpha 0.5 by likelihood) and a 5-round hazard scalar.
- Lowered distance/rounds shrink weights 0.45 → 0.30 and method/ITD 0.40 → 0.35 (sim under-dispersed vs. market on distance).
- Sim recalibrated on the latest 18 months (finish rates rose in 2026; the old calibration over-predicted decisions on the hold-out: 50% predicted vs. 35% observed).
- Added a per-fighter grappling form term (takedown overdispersion: P(1+ TD) was 61% predicted vs. 39% observed), a TD-rate scale per group, and a calibrated strike form sigma (sig 80% coverage 72% → 80%).
- 5-round hazard scalar now per weight group (HW/LHW 5-rounders go to decision 22% vs. 45% pooled).
- Price-target solver: scan outward from the fair price (edge is non-monotone in price after shrinkage); the old bisection returned "no price" for nearly everything.
- Moneyline candidates used the market-tilted sim probability as p_model (double shrink): fixed to use the win-model probability.
- MOST_SIG / MOST_TD: a tie is a push and comparisons are tie-excluded (books devig them two-way).
- Tilt solver: logit-secant instead of bisection (Poisson sampling breaks common-random-number monotonicity).
- Win model: C 0.5 → 0.05 (walk-forward log loss), LR + GB ensemble (w_gb 0.3 from out-of-fold).
- Min two-sided books 2 → 1 with a 1.25× edge requirement for single-book markets (most props are only on the Kambi books).
- Robustness weight in the composite score: share of shrink-weight perturbations (±25%) under which a bet still clears.
