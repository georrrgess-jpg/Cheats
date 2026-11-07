# STATUS

- **Clock:** 14:10 ET, Sat Nov 7 2026
- **Current milestone:** M1 (data ready), in progress
- **Next step:** write src/baserates.py + data-quality validation (src/checks.py validate_data), then src/simulate.py

## Milestones
- [x] M0 Setup + card verified (14:10): venv, dataset, `output/card_verification.md`, all 28 names resolved
- [ ] M1 Data ready (target 15:00)
- [ ] M2 Features + win model (15:35). Feature pass and walk-forward LR already work (LL 0.646 vs. Elo 0.681)
- [ ] M3 Simulator + fair prices (16:05)
- [ ] M4 = R1 (16:30)
- [ ] M5 T2 upgrades
- [ ] M6 = R2 (19:30)
- [ ] M7 Post-event

## Inputs
Every Handoff Input was blank, so defaults are in use: cloud, `./ufc_model`, 100 units, 1 unit = 1%, no books (consensus / median price, line shopping off), no Odds API key, raw-paste props, no pick'em, max 6 bets, no parlays, shortest −300.

## Open issues / flags
- UFCStats.com has a JS bot check, so I use the Greco1899 public dataset (fresh through Oct 31 2026).
- UFC.com 403 and Tapology 403. MMADecisions isn't reachable, so the T2 round-scoring model uses the fallback.
- Debutants: Souza, Calderon (4 days' notice), Lorenço, Degli. Short notice: Cortes-Acosta and Walker (9 days). Booking dates for the Petroski and Petersen replacements weren't verified.
- BestFightOdds carries ML, method, rounds, distance and ITD props for all 14 bouts. No sig-strike or takedown lines yet (asked the user).

## Last run
- none yet
