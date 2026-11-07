#!/usr/bin/env python
"""Full pipeline: data -> features -> win model -> simulator -> markets -> odds -> edges -> best bets -> outputs.

  python run_tonight.py --event "UFC Vegas 124"
  python run_tonight.py --event "UFC Vegas 124" --odds-only
  python run_tonight.py --event "UFC Vegas 124" --exclude-bout Lorenco-Petersen
  python run_tonight.py --event "UFC Vegas 124" --fast
"""
from __future__ import annotations

import argparse
import json
import pickle
import shutil
import sys
import time
from multiprocessing import Pool

import numpy as np
import pandas as pd

from src import report
from src.baserates import compute as compute_baserates, lookup as br_lookup
from src.calibrate_sim import calibrate
from src.checks import CheckFailed, check_bout_markets, check_sim_bounds, validate_data, write_data_quality
from src.edge import consensus, shrink, weight_for
from src.features import build_features, league_rates, pair_matrix
from src.markets import price_bout, prob_of
from src.names import load_overrides, resolve
from src.odds import load_all_odds
from src.rank import build_candidates, dedupe_correlated, price_targets
from src.scrape_card import load_card
from src.simulate import load_globals, make_params, simulate, solve_tilt
from src.staking import stake
from src.store import build_tables
from src.uncertainty import boot_bout
from src.util import ROOT, cfg, new_run_id, p, seed_all, setup_logging
from src.winprob import LRModel, fit_temperature, sigmoid, training_frame, walk_forward

SIM_KEYS = ["winner", "method", "end_t", "end_round", "sigA", "sigB", "tdA", "tdB", "kdA", "kdB", "rounds", "n"]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", default="UFC Vegas 124")
    ap.add_argument("--odds-only", action="store_true")
    ap.add_argument("--exclude-bout", action="append", default=[])
    ap.add_argument("--fast", action="store_true", help="fewer sims / bootstrap reps (testing)")
    ap.add_argument("--no-fetch", action="store_true", help="use cached odds pages")
    ap.add_argument("--recalibrate", action="store_true")
    ap.add_argument("--release", default="", help="label for this run (R1, R2, ...)")
    a = ap.parse_args(argv)
    C = cfg()
    run_id = new_run_id()
    log = setup_logging(run_id)
    t0 = time.time()
    log.info("run %s event=%s odds_only=%s", run_id, a.event, a.odds_only)
    ecfg = C["events"][a.event]
    seed = C["seed"]
    seed_all(seed)
    cache_path = ROOT / f"data/processed/cache_{ecfg['output_prefix']}.pkl"
    excluded = set(a.exclude_bout)
    excl_file = ROOT / f"data/processed/excluded_{ecfg['output_prefix']}.json"
    if excl_file.exists():
        excluded |= set(json.loads(excl_file.read_text()))
    excl_file.write_text(json.dumps(sorted(excluded)))

    if a.odds_only:
        if not cache_path.exists():
            log.error("no cache for --odds-only; run the full pipeline first")
            return 2
        st = pickle.load(open(cache_path, "rb"))
        card, bouts, sims, ctx = st["card"], st["bouts"], st["sims"], st["ctx"]
    else:
        st = None
    # ------------------------------------------------------------------ data + card
    T = build_tables()
    errs, warns = validate_data(T, ecfg["date"])
    if errs:
        write_data_quality(T, errs, warns, {})
        raise CheckFailed(f"data validation failed: {errs}")
    fz = T["fighters"]
    cand = dict(zip(fz.fighter_id, fz.name))
    ov = load_overrides()
    if st is None:
        card = load_card(a.event)
        unmatched = []
        ids_a, ids_b = [], []
        for r in card.itertuples():
            fa, ha, _ = resolve(r.fighter_a, cand, ov, C["names"]["fuzzy_threshold"])
            fb, hb, _ = resolve(r.fighter_b, cand, ov, C["names"]["fuzzy_threshold"])
            ids_a.append(fa); ids_b.append(fb)
            if fa is None: unmatched.append(r.fighter_a)
            if fb is None: unmatched.append(r.fighter_b)
        card["a_id"], card["b_id"] = ids_a, ids_b
        if unmatched:
            log.error("UNMATCHED NAMES (bouts skipped): %s", unmatched)
    card["excluded"] = card.bout_key.isin(excluded) | card.a_id.isna() | card.b_id.isna()
    ev_date = pd.Timestamp(ecfg["date"])
    fighter_ids = {i: cand[i] for i in list(card.a_id.dropna()) + list(card.b_id.dropna())}

    if st is None:
        # ---------------------------------------------------------------- features
        L = league_rates(T, C["data"]["league_min_year"])
        snaps_req = []
        for r in card.itertuples():
            wc = r.weight_class
            snaps_req += [(f"{r.bout_key}|A", r.a_id, wc, r.gender, ev_date), (f"{r.bout_key}|B", r.b_id, wc, r.gender, ev_date)]
        F, snaps, elo, S, L = build_features(T, L, snaps_req)
        F.to_parquet(ROOT / "data/processed/features.parquet")
        pickle.dump(L, open(ROOT / "data/processed/league.pkl", "wb"))
        log.info("features built (%d rows) %.0fs", len(F), time.time() - t0)
        # ---------------------------------------------------------------- win model
        X, y, meta = training_frame(F, T["fights"], C["data"]["model_min_year"])
        oof_path = ROOT / "data/processed/oof.parquet"
        if oof_path.exists():
            oof = pd.read_parquet(oof_path)
        else:
            oof = walk_forward(X, y, meta, C["winprob"]["backtest_start"], C["winprob"]["C"])
            oof.to_parquet(oof_path)
        hold_start = meta.date.max() - pd.DateOffset(months=C["winprob"]["holdout_months"])
        temp = fit_temperature(oof.z_lr[oof.date < hold_start].values, oof.y[oof.date < hold_start].values)
        lr = LRModel(C["winprob"]["C"]).fit(X, y)
        ens = {"w_gb": 0.0}
        ens_path = ROOT / "data/processed/ensemble.json"
        if C["winprob"].get("ensemble", False) and ens_path.exists():
            ens = json.loads(ens_path.read_text())
            if ens.get("w_gb", 0) > 0:
                from src.winprob import GBModel
                gbm = GBModel(seed).fit(X, y)
                log.info("ensemble on: w_gb=%.2f (out-of-fold weight from backtest.py)", ens["w_gb"])
        # ---------------------------------------------------------------- simulator globals
        if a.recalibrate or not (ROOT / "data/processed/sim_globals.json").exists():
            # production calibration: most recent 18 months (includes the backtest hold-out; see BACKTEST.md)
            calibrate(T, F, L, T["fights"].date.max() + pd.Timedelta(days=1))
        G = load_globals()
        br = compute_baserates(T)
        ctx = {"temp": temp, "L": L, "G": G, "snaps": snaps, "ensemble": ens}
    else:
        temp, L, G, snaps = ctx["temp"], ctx["L"], ctx["G"], ctx["snaps"]
        br = compute_baserates(T, save=False)

    # ------------------------------------------------------------------ odds
    quotes, odds_issues = load_all_odds(a.event, card, fighter_ids, fetch=not a.no_fetch)
    live = set(card.loc[~card.excluded, "bout_key"])
    cancelled_quotes = quotes[~quotes.bout_key.isin(set(card.bout_key))]
    quotes = quotes[quotes.bout_key.isin(live)]
    cons, per_book = consensus(quotes, C) if len(quotes) else (pd.DataFrame(columns=["bout_key", "key", "market", "p_fair"]), pd.DataFrame())
    log.info("odds: %d quotes, %d priced selections, %d issues", len(quotes), len(cons), len(odds_issues))

    # ------------------------------------------------------------------ per-bout model
    n_sims = 4000 if a.fast else C["sim"]["n_sims"]
    if st is None:
        bouts, sims = [], {}
        boot_jobs = []
        reps = 10 if a.fast else C["uncertainty"]["boot_reps"]
        for r in card.itertuples():
            B = {"bout_key": r.bout_key, "bout_order": int(r.bout_order), "segment": r.segment,
                 "fighter_a": r.fighter_a, "fighter_b": r.fighter_b, "weight_class": r.weight_class,
                 "gender": r.gender, "rounds": int(r.scheduled_rounds), "is_main_event": r.bout_order == card.bout_order.max(),
                 "excluded": bool(r.excluded), "start_time_utc": r.start_time_utc, "note": r.booked_note if isinstance(r.booked_note, str) else ""}
            if r.excluded:
                bouts.append(B)
                continue
            sA, sB = snaps[f"{r.bout_key}|A"], snaps[f"{r.bout_key}|B"]
            ctx_df = pd.DataFrame({"weight_class": [r.weight_class]})
            Xb = pair_matrix(pd.DataFrame([sA]), pd.DataFrame([sB]), ctx_df)
            z_lr = float(lr.logit(Xb)[0]) * temp
            z = z_lr
            if ens.get("w_gb", 0) > 0:
                z = (1 - ens["w_gb"]) * z_lr + ens["w_gb"] * ens["temp_gb"] * float(gbm.logit(Xb)[0])
            se = max(float(lr.logit_se(Xb)[0]) * temp, C["uncertainty"]["ml_logit_se_floor"])
            debut = sA["n_fights"] == 0 or sB["n_fights"] == 0
            if debut:
                se = max(se, C["uncertainty"]["debut_logit_se"])
            contrib = lr.contributions(Xb).iloc[0] * temp
            p_model_ml = float(sigmoid(z))
            low = any((s["n_fights"] < C["features"]["low_sample_fights"] and s["ufc_minutes"] < C["features"]["low_sample_minutes"]) for s in (sA, sB))
            sn = bool(r.short_notice_a == 1 or r.short_notice_b == 1)
            # market ML (vig-free, consensus)
            mlq = cons[(cons.bout_key == r.bout_key) & (cons.key == "ML|A")]
            p_fair_ml = float(mlq.p_fair.iloc[0]) if len(mlq) else np.nan
            w_ml = weight_for("ML", C, r.segment, B["is_main_event"])
            p_final_ml = shrink(p_model_ml, p_fair_ml, w_ml)
            bp = make_params(sA, sB, L, r.weight_class, r.gender, r.scheduled_rounds, G)
            tilt, p_sim = solve_tilt(bp, p_final_ml, seed + r.bout_order, C["sim"]["n_sims_tilt"], G, C["sim"]["tilt_tol"])
            # refine on the final sample (same seed and n as the sims used for pricing)
            tilt, p_sim = solve_tilt(bp, p_final_ml, seed + 100 + r.bout_order, n_sims, G, C["sim"]["tilt_tol"] / 2,
                                     lo=tilt - 0.25, hi=tilt + 0.25)
            sim = simulate(bp, n_sims, seed + 100 + r.bout_order, tilt, G)
            pr = price_bout(sim, grid_halfwidth=C["markets"]["sig_line_grid_halfwidth"], td_lines=C["markets"]["td_lines"])
            sim_pa = pr["probs"]["ML|A"] / max(1 - pr["probs"]["DRAW|YES"], 1e-9)
            fails = check_bout_markets(pr, p_final_ml)
            if abs(sim_pa - p_final_ml) > C["sim"]["tilt_tol"] + 2 * pr["mcse_max"]:
                fails.append(f"sim P(A) {sim_pa:.3f} vs p_final {p_final_ml:.3f}")
            bounds = check_sim_bounds(pr, br_lookup(br, r.weight_class, r.gender, int(r.scheduled_rounds)).to_dict())
            B.update({
                "a_id": r.a_id, "b_id": r.b_id, "snapA": sA, "snapB": sB, "p_model_ml": p_model_ml, "logit_se": se,
                "p_fair_ml": p_fair_ml, "p_final_ml": p_final_ml, "elo_p": 1 / (1 + 10 ** ((sB["elo"] - sA["elo"]) / C["elo"]["scale"])),
                "tilt": tilt, "tilt_flag": abs(tilt) > C["sim"]["tilt_max"], "sim_pa": sim_pa, "probs": pr["probs"],
                "summary": pr["summary"], "pmfs": {k: v[:200].tolist() for k, v in pr["pmfs"].items()},
                "mcse_max": pr["mcse_max"], "sig_lines": pr["sig_lines"], "checks_failed": fails, "bounds_flags": bounds,
                "props_dropped": bool(fails or bounds), "debut": debut, "low_sample": low, "short_notice": sn,
                "drivers": contrib.abs().sort_values(ascending=False).head(3).index.tolist(),
                "driver_vals": {k: float(contrib[k]) for k in contrib.abs().sort_values(ascending=False).head(3).index},
                "w_ml": w_ml,
            })
            sims[r.bout_key] = {k: sim[k] for k in SIM_KEYS}
            p_draws = sigmoid(z + se * np.random.default_rng(seed + 5 * r.bout_order).standard_normal(max(reps, 200)))
            B["ml_draws"] = p_draws.tolist()
            p_draws = p_draws[:reps]
            p_draws_final = [shrink(float(p), p_fair_ml, w_ml) for p in p_draws]
            boot_jobs.append((len(bouts), (sA, sB, L, r.weight_class, r.gender, int(r.scheduled_rounds), p_draws_final, G,
                                           1000, 2500 if a.fast else C["sim"]["n_sims_boot"], seed + 31 * r.bout_order,
                                           pr["sig_lines"])))
            bouts.append(B)
            log.info("%-26s p_model=%.3f fair=%s final=%.3f tilt=%+.2f dist=%.2f checks=%s", r.bout_key, p_model_ml,
                     f"{p_fair_ml:.3f}" if np.isfinite(p_fair_ml) else "n/a", p_final_ml, tilt, pr["probs"]["DIST|YES"],
                     "OK" if not (fails or bounds) else fails + bounds)
        log.info("sims done %.0fs; bootstrap %d reps x %d bouts", time.time() - t0, reps, len(boot_jobs))
        with Pool(4) as pool:
            res = pool.map(boot_bout, [j for _, j in boot_jobs])
        for (bi, _), draws in zip(boot_jobs, res):
            bouts[bi]["boot"] = draws
        log.info("bootstrap done %.0fs", time.time() - t0)
        pickle.dump({"card": card, "bouts": bouts, "sims": sims, "ctx": ctx, "run_id": run_id}, open(cache_path, "wb"))
    else:
        for B in bouts:
            B["excluded"] = B["bout_key"] in excluded or B.get("excluded", False)
            if not B["excluded"] and "probs" in B:
                mlq = cons[(cons.bout_key == B["bout_key"]) & (cons.key == "ML|A")]
                new_fair = float(mlq.p_fair.iloc[0]) if len(mlq) else np.nan
                if np.isfinite(new_fair) and np.isfinite(B["p_fair_ml"]) and abs(new_fair - B["p_fair_ml"]) > 0.03:
                    log.warning("%s: ML fair moved %.3f -> %.3f; props use the cached tilt (run full pipeline to re-tilt)",
                                B["bout_key"], B["p_fair_ml"], new_fair)
                B["p_fair_ml_now"] = new_fair

    # ------------------------------------------------------------------ biggest disagreements, candidates, ranking
    cand_df = build_candidates(bouts, cons, C)
    pt = price_targets(bouts, cons, C)
    passing = cand_df[cand_df.passes] if len(cand_df) else cand_df
    if len(passing):
        passing = dedupe_correlated(passing, sims, C["filters"]["corr_max"])
    rec = passing.sort_values("composite", ascending=False).head(C["filters"]["max_bets"]) if len(passing) else passing
    rec = stake(rec, C["staking"])
    rec = rec.sort_values(["bout_order", "composite"], ascending=[True, False])
    lists = {
        "best_value": passing.sort_values("ev", ascending=False).head(5) if len(passing) else passing,
        "most_likely": passing.sort_values("p_final", ascending=False).head(5) if len(passing) else passing,
        "best_overall": passing.sort_values("composite", ascending=False).head(5) if len(passing) else passing,
    }
    if len(cand_df):
        nf = cand_df.fail.str.count(";") + (cand_df.fail != "").astype(int)
        near = cand_df[(cand_df.ev > 0) & (nf == 1) & (cand_df.p_ev_pos >= C["filters"]["p_ev_pos_min"]) &
                       ~cand_df.market.isin(C["filters"]["exclude_markets"])].sort_values("composite", ascending=False).head(8)
    else:
        near = cand_df
    lists["near_misses"] = near
    disagreements = cand_df.assign(gap=(cand_df.p_model - cand_df.p_fair).abs()).sort_values("gap", ascending=False).head(10) if len(cand_df) else cand_df
    # pass list
    pass_list = []
    for B in bouts:
        if B.get("excluded"):
            pass_list.append((B["bout_key"], "excluded / off"))
            continue
        if len(rec) and B["bout_key"] in set(rec.bout_key):
            continue
        cb = cand_df[cand_df.bout_key == B["bout_key"]] if len(cand_df) else cand_df
        if not len(cb):
            reason = "no quotes"
        elif cb.passes.any():
            reason = "had a qualifying bet, but it was outranked (max bets) or correlated"
        elif B.get("debut"):
            reason = "debutant uncertainty: nothing clears the stricter edge requirement"
        elif (cb.ev > 0).any():
            reason = "small +EV spots, but below the edge/P(EV>0) thresholds"
        else:
            reason = "market efficient: no +EV price at the consensus"
        pass_list.append((B["bout_key"], reason))
    out = {"run_id": run_id, "release": a.release, "event": a.event, "card": card, "bouts": bouts, "cons": cons, "sims": sims,
           "quotes": quotes, "per_book": per_book, "cand": cand_df, "rec": rec, "lists": lists, "pt": pt,
           "disagreements": disagreements, "pass_list": pass_list, "odds_issues": odds_issues, "warns": warns,
           "cancelled_quotes": len(cancelled_quotes), "temp": temp, "base_rates": br, "elapsed": time.time() - t0}
    write_data_quality(T, errs, warns, {
        "Tonight's fighters": [f"{B['fighter_a']} ({B['snapA']['n_fights']} UFC fights, {B['snapA']['ufc_minutes']:.0f} min) vs "
                               f"{B['fighter_b']} ({B['snapB']['n_fights']} UFC fights, {B['snapB']['ufc_minutes']:.0f} min)"
                               + (" [DEBUTANT]" if B['debut'] else "") + (" [low sample]" if B['low_sample'] else "")
                               for B in bouts if "snapA" in B],
        "Missing physical data (tonight)": [f"{B['fighter_' + s.lower()]}: " + ", ".join(k for k in ("age", "reach", "height") if not np.isfinite(B['snap' + s].get(k, np.nan)))
                                            for B in bouts if "snapA" in B for s in ("A", "B")
                                            if any(not np.isfinite(B['snap' + s].get(k, np.nan)) for k in ("age", "reach", "height"))] or ["none"],
        "Odds intake": [f"{len(quotes)} quotes, {len(cons)} priced selections, books: {', '.join(sorted(quotes.book.unique())) if len(quotes) else 'none'}",
                        "No sig-strike / takedown / knockdown lines on BestFightOdds; those markets are fair price + price target only until lines arrive."]
                       + [f"unparsed: {x}" for x in sorted(set(odds_issues))[:40]],
        "Simulator checks": [f"{B['bout_key']}: {B['checks_failed'] + B['bounds_flags']}" for B in bouts if B.get('checks_failed') or B.get('bounds_flags')] or ["all bouts pass"],
    })
    report.write_all(out, C)
    rd = p(f"output/runs/{run_id}/x").parent
    for f in ["report.md", "handoff_summary.md", "predictions.json", f"{ecfg['output_prefix']}_model.xlsx", "data_quality.md"]:
        if (ROOT / "output" / f).exists():
            shutil.copy(ROOT / "output" / f, rd / f)
    report.console(out)
    log.info("done in %.0fs: output/%s_model.xlsx", time.time() - t0, ecfg["output_prefix"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
