# STATUS

- **Clock:** 15:00 ET
- **Current milestone:** M5 mostly done. R1.1 shipped 15:00 (all T2 upgrades + audit fixes). Waiting for the 16:40 prelim refresh and 19:05 R2 (both scheduled)
- **Next step:** T2. (a) Clean hold-out check of the recalibrated sim (calibrate on the 18 months before 2026-04-30, re-run backtest sim hold-out). (b) GB ensemble into the win model (w_gb=0.3 helped hold-out LL 0.658→0.657). (c) 200 bootstrap reps. (d) Start watch_odds.py. (e) Independent audit subagent (§30). (f) R2 at 19:30: `python run_tonight.py --event "UFC Vegas 124" --release R2`

## Milestones
- [x] M0 Setup + card verified (14:10)
- [x] M1 Data ready (14:30)
- [x] M2 Features + win model (14:30). Leakage tests pass
- [x] M3 Simulator + fair prices (14:47). §23 checks pass for all 14 bouts; Price Targets sheet written
- [x] M4 = R1 (14:50). No bet clears every filter; near misses listed (all red flags)
- [x] M5 T2 upgrades (15:00): full + clean hold-out backtest, GB ensemble, per-group 5-rd hazards, charts, robustness weight, §30 audit fixes, odds watcher running. Still 50 bootstrap reps; 200 at R2
- [ ] M6 = R2 (19:30)
- [ ] M7 Post-event (grade_results.py written)

## Inputs
Every Handoff Input was blank, so defaults are in use: cloud, `./ufc_model`, 100 units, 1 unit = 1%, no books (consensus / median price, line shopping off), no Odds API key, raw-paste props (none received yet), no pick'em, max 6 bets, no parlays, shortest −300.

## Open issues / flags
- No sig-strike / takedown / knockdown quotes (not on BestFightOdds); Price Targets only until the user pastes lines.
- Red-flag bouts (|model − market| > 15 pts): Raposo-Degli ML (Degli debut), Ko-Turman ML, Cortes-Acosta-Walker rounds/distance (HW 5-round, short notice), Kondratavičius-Petroski rounds.
- Debutants: Souza, Calderon (4 days' notice), Lorenço, Degli. Short notice: Cortes-Acosta and Walker.
- Booking dates for the Petroski and Petersen replacements weren't verified.
- Sim calibration window is the last 18 months (finish rates rose in 2026). The hold-out check in BACKTEST.md predates this recalibration.

## Last run
- run id: 20261107T195740Z-78e885; outputs: output/UFC_Vegas_124_model.xlsx, output/report.md, output/handoff_summary.md
