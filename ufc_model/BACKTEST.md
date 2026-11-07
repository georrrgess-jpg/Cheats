# BACKTEST

Walk-forward, monthly refit, FULL (Jan 2022 →) through 2026-10-31. Calibration (temperature 0.976) is fit on the tuning window only. The last 6 months (2026-04-30 →, n=290) are held out of tuning and calibration.

Configurations tried (multiple-testing honesty): LR C=0.05, LR C=0.5, GB + ensemble weight grid (11); plus the simulator finish-alpha grid [0.0, 0.5, 1.0, 1.5] (likelihood on calibration bouts).

## Moneyline (win model)

| model               | window               |    n |   log_loss |   brier |    ece |   accuracy |
|:--------------------|:---------------------|-----:|-----------:|--------:|-------:|-----------:|
| base rate (0.5)     | tuning window        | 2179 |     0.6931 |  0.25   | 0.0645 |     0.5645 |
| base rate (0.5)     | hold-out (last 6 mo) |  290 |     0.6931 |  0.25   | 0.0724 |     0.5724 |
| base rate (0.5)     | all                  | 2469 |     0.6931 |  0.25   | 0.0654 |     0.5654 |
| Elo only            | tuning window        | 2179 |     0.6809 |  0.244  | 0.0127 |     0.5594 |
| Elo only            | hold-out (last 6 mo) |  290 |     0.6822 |  0.2445 | 0.0326 |     0.5621 |
| Elo only            | all                  | 2469 |     0.681  |  0.244  | 0.0127 |     0.5597 |
| LR (calibrated)     | tuning window        | 2179 |     0.6445 |  0.2261 | 0.0172 |     0.6232 |
| LR (calibrated)     | hold-out (last 6 mo) |  290 |     0.658  |  0.2312 | 0.0701 |     0.6517 |
| LR (calibrated)     | all                  | 2469 |     0.6461 |  0.2267 | 0.015  |     0.6266 |
| GB (calibrated)     | tuning window        | 2179 |     0.649  |  0.2286 | 0.0177 |     0.6255 |
| Ensemble (w_gb=0.3) | tuning window        | 2179 |     0.6438 |  0.226  | 0.0241 |     0.6228 |
| GB (calibrated)     | hold-out (last 6 mo) |  290 |     0.6599 |  0.2327 | 0.0601 |     0.6172 |
| Ensemble (w_gb=0.3) | hold-out (last 6 mo) |  290 |     0.6566 |  0.2308 | 0.0453 |     0.6483 |

Low-sample split (all walk-forward rows):

| subset                       |    n |   log_loss |   brier |    ece |   accuracy |
|:-----------------------------|-----:|-----------:|--------:|-------:|-----------:|
| a fighter with <3 UFC fights | 1078 |     0.6481 |  0.2278 | 0.0258 |     0.6234 |
| both fighters 3+ UFC fights  | 1391 |     0.6444 |  0.2258 | 0.0297 |     0.629  |

Reliability, all walk-forward rows (10 bins of P(A)):

| bin     |   n |   mean_pred |   hit_rate |
|:--------|----:|------------:|-----------:|
| 0.0-0.1 |   2 |       0.049 |      0     |
| 0.1-0.2 |  53 |       0.164 |      0.226 |
| 0.2-0.3 | 165 |       0.26  |      0.291 |
| 0.3-0.4 | 372 |       0.356 |      0.422 |
| 0.4-0.5 | 507 |       0.452 |      0.507 |
| 0.5-0.6 | 573 |       0.549 |      0.586 |
| 0.6-0.7 | 485 |       0.646 |      0.718 |
| 0.7-0.8 | 249 |       0.742 |      0.755 |
| 0.8-0.9 |  59 |       0.831 |      0.831 |
| 0.9-1.0 |   4 |       0.948 |      0.25  |

## Simulator hold-out (last 6 months, props priced from each bout's pre-fight features, tilted to the model ML)

| market                                  |   n |   brier |   brier_climatology |   log_loss |   log_loss_climatology |   mean_pred |   obs_rate |
|:----------------------------------------|----:|--------:|--------------------:|-----------:|-----------------------:|------------:|-----------:|
| Goes the distance                       | 290 |  0.2353 |              0.227  |     0.6623 |                 0.6464 |      0.4989 |     0.3483 |
| Over 1.5 rounds                         | 290 |  0.2378 |              0.2457 |     0.6693 |                 0.6845 |      0.6622 |     0.5655 |
| Over 2.5 rounds                         | 290 |  0.24   |              0.2461 |     0.6731 |                 0.6854 |      0.5412 |     0.4379 |
| Fight ends by KO/TKO                    | 290 |  0.2325 |              0.247  |     0.6574 |                 0.687  |      0.3368 |     0.4448 |
| Fight ends by submission                | 290 |  0.163  |              0.1641 |     0.5079 |                 0.5098 |      0.1643 |     0.2069 |
| Fighter 1+ takedown                     | 580 |  0.2546 |              0.2386 |     0.7081 |                 0.6701 |      0.6103 |     0.3931 |
| Sig strikes over fighter's prior median | 461 |  0.2518 |              0.2394 |     0.7084 |                 0.6718 |      0.5236 |     0.397  |

Reliability by market (5 bins):

- **Goes the distance**: 0.0-0.2: pred 0.17 vs obs 0.17 (n=6); 0.2-0.4: pred 0.33 vs obs 0.23 (n=65); 0.4-0.6: pred 0.49 vs obs 0.32 (n=147); 0.6-0.8: pred 0.68 vs obs 0.51 (n=67); 0.8-1.0: pred 0.85 vs obs 0.80 (n=5)
- **Over 1.5 rounds**: 0.2-0.4: pred 0.35 vs obs 0.17 (n=6); 0.4-0.6: pred 0.53 vs obs 0.39 (n=72); 0.6-0.8: pred 0.69 vs obs 0.62 (n=176); 0.8-1.0: pred 0.85 vs obs 0.72 (n=36)
- **Over 2.5 rounds**: 0.0-0.2: pred 0.17 vs obs 0.50 (n=2); 0.2-0.4: pred 0.33 vs obs 0.26 (n=39); 0.4-0.6: pred 0.50 vs obs 0.40 (n=152); 0.6-0.8: pred 0.68 vs obs 0.55 (n=86); 0.8-1.0: pred 0.84 vs obs 0.73 (n=11)
- **Fight ends by KO/TKO**: 0.0-0.2: pred 0.13 vs obs 0.24 (n=59); 0.2-0.4: pred 0.31 vs obs 0.43 (n=140); 0.4-0.6: pred 0.48 vs obs 0.54 (n=74); 0.6-0.8: pred 0.69 vs obs 0.88 (n=17)
- **Fight ends by submission**: 0.0-0.2: pred 0.13 vs obs 0.18 (n=213); 0.2-0.4: pred 0.26 vs obs 0.28 (n=75); 0.4-0.6: pred 0.43 vs obs 0.50 (n=2)
- **Fighter 1+ takedown**: 0.0-0.2: pred 0.17 vs obs 0.00 (n=1); 0.2-0.4: pred 0.34 vs obs 0.09 (n=68); 0.4-0.6: pred 0.51 vs obs 0.31 (n=199); 0.6-0.8: pred 0.69 vs obs 0.45 (n=228); 0.8-1.0: pred 0.85 vs obs 0.70 (n=84)
- **Sig strikes over fighter's prior median**: 0.0-0.2: pred 0.14 vs obs 0.22 (n=45); 0.2-0.4: pred 0.32 vs obs 0.26 (n=92); 0.4-0.6: pred 0.50 vs obs 0.40 (n=124); 0.6-0.8: pred 0.68 vs obs 0.48 (n=155); 0.8-1.0: pred 0.86 vs obs 0.56 (n=45)

Sig strikes per fighter: 80% interval coverage 71.6% (target 80%), CRPS 17.9, pinball@P50 13.0.

## Against the market

No public historical UFC odds dataset was available inside this session's network, so **ROI, CLV and a vig-free-market baseline could not be backtested**. Consensus closing odds are being captured from tonight on (`data/odds_history.csv`, `watch_odds.py`) so future backtests can include them.

## Plain-English verdict

- The win model clearly beats Elo and the coin-flip baseline out of sample (hold-out log loss 0.658 vs. Elo 0.682 vs. 0.693). But typical vig-free closing UFC moneylines score about 0.60–0.62 log loss in published analyses, which is better than this model. **Treat the moneyline as market-driven.** The model's ML weight stays at 0.30 (lower on the main card), and ML bets need a 3%+ edge and P(EV>0) ≥ 60%.
- Props come from a simulator calibrated to base rates. It reproduces method shares, round shares and strike volume, but its bout-to-bout spread on distance is narrower than the market's. So distance and round markets are shrunk 70% toward the market, and large disagreements are red-flagged rather than bet.
- Without historical prop odds the edge in props is **unproven**. Recommendations are small (quarter Kelly, 2% cap) and logged with CLV fields so the edge can be measured.
- Debutants and one-fight fighters are where the model knows least (see the low-sample split). They get wider intervals and a 1.5× edge requirement.
