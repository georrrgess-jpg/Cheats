# CLAUDE.md: UFC betting model (project conventions)

Resume: read `STATUS.md` (the "Next step" line), then `ASSUMPTIONS.md`. Don't redo finished milestones.

## Run
```
cd ufc_model && . .venv/bin/activate
python run_tonight.py --event "UFC Vegas 124"            # full pipeline
python run_tonight.py --event "UFC Vegas 124" --odds-only  # re-pull odds and re-rank from cached sims
python run_tonight.py --event "UFC Vegas 124" --exclude-bout Lorenco-Petersen
python backtest.py          # walk-forward evaluation, writes BACKTEST.md
python watch_odds.py --event "UFC Vegas 124" --every 12   # closing-line snapshots
python grade_results.py --event "UFC Vegas 124"
pytest -q
```

## Conventions
- All tunables live in `config.yaml`. Market codes are in README.md §Market codes.
- Probabilities are 0–1 internally; American odds for display, decimal for math; seconds internally.
- Bout key = `LastA-LastB` in official order (accents stripped). Cards live in `data/cards/*.csv`, events in `config.yaml: events`.
- Never fabricate odds or stats. Missing data gets flagged and skipped.
- The data store is `data/processed/*.parquet`, rebuilt from `data/raw_cache/greco/` by `src/store.py`.
- Outputs go to `output/`; run history to `output/runs/<run_id>/`; picks are appended to `data/picks_log.csv`.
