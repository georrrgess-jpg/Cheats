# CHANGELOG

## 2026-11-07
- Initial build for UFC Vegas 124 (data, features, Elo + logistic win model, calibrated simulator, markets, devig, BestFightOdds intake, ranking, staking, reports, tests, backtest).
- Sim calibration: added fighter finish-propensity term (alpha 0.5 by likelihood) and a 5-round hazard scalar.
- Lowered distance/rounds shrink weights 0.45 → 0.30 and method/ITD 0.40 → 0.35 (sim under-dispersed vs. market on distance).
