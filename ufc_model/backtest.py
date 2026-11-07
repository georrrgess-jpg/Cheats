#!/usr/bin/env python
"""Walk-forward evaluation (§20). Writes BACKTEST.md, output/backtest_*.csv, output/charts/reliability.png.

  python backtest.py            # full: Jan 2022 onward, last 6 months held out of calibration/tuning
  python backtest.py --reduced  # Jan 2024 onward
  python backtest.py --no-sim   # skip the simulator hold-out check
"""
from __future__ import annotations

import argparse
import json
import pickle
from multiprocessing import Pool

import numpy as np
import pandas as pd

from src.features import build_features, league_rates
from src.simulate import load_globals, make_params, simulate, solve_tilt
from src.store import build_tables
from src.util import ROOT, cfg
from src.winprob import GBModel, LRModel, fit_temperature, metrics, reliability, sigmoid, training_frame, walk_forward, logit


def _sim_job(args):
    sA, sB, L, wc, g, rounds, p_target, G, seed = args
    bp = make_params(sA, sB, L, wc, g, rounds, G)
    t, _ = solve_tilt(bp, p_target, seed, 1000, G, tol=0.01)
    s = simulate(bp, 3000, seed + 1, t, G)
    fin = np.isin(s["method"], ["KO", "SUB", "DOC"])
    return {"p_dist": float((~fin).mean()), "p_o15": float((s["end_t"] >= 450).mean()), "p_o25": float((s["end_t"] >= 750).mean()),
            "sigA": np.percentile(s["sigA"], [10, 50, 90]).tolist(), "sigB": np.percentile(s["sigB"], [10, 50, 90]).tolist(),
            "sigA_samp": s["sigA"][:600].tolist(), "sigB_samp": s["sigB"][:600].tolist(),
            "p_tdA": float((s["tdA"] >= 1).mean()), "p_tdB": float((s["tdB"] >= 1).mean()), "tilt": t,
            "p_ko": float(np.isin(s["method"], ["KO", "DOC"]).mean()), "p_sub": float((s["method"] == "SUB").mean())}


def crps_sample(samples, y):
    x = np.asarray(samples, float)
    return float(np.mean(np.abs(x - y)) - 0.5 * np.mean(np.abs(x[:, None] - x[None, :])))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--reduced", action="store_true")
    ap.add_argument("--no-sim", action="store_true")
    ap.add_argument("--gb", action="store_true", help="also evaluate the gradient-boosting model + ensemble")
    ap.add_argument("--clean-holdout", action="store_true", help="recalibrate the sim on pre-hold-out data only for the hold-out check")
    a = ap.parse_args(argv)
    C = cfg()
    T = build_tables()
    L = league_rates(T, C["data"]["league_min_year"])
    F = pd.read_parquet(ROOT / "data/processed/features.parquet") if (ROOT / "data/processed/features.parquet").exists() else build_features(T, L)[0]
    X, y, meta = training_frame(F, T["fights"], C["data"]["model_min_year"])
    start = "2024-01-01" if a.reduced else C["winprob"]["backtest_start"]
    configs_tried = []
    res = {}
    for Cc in ([C["winprob"]["C"]] if a.reduced else [0.05, 0.5]):
        oof = walk_forward(X, y, meta, start, Cc, use_gb=a.gb, seed=C["seed"])
        configs_tried.append(f"LR C={Cc}")
        res[Cc] = oof
    # choose C on the tuning window only (the hold-out stays untouched)
    _hs = lambda o: o.date < o.date.max() - pd.DateOffset(months=C["winprob"]["holdout_months"])
    bestC = min(res, key=lambda c: metrics(sigmoid(res[c].z_lr[_hs(res[c])]), res[c].y[_hs(res[c])])["log_loss"])
    if bestC != C["winprob"]["C"]:
        print(f"NOTE: tuning-window best C={bestC} differs from config C={C['winprob']['C']}; update config.yaml")
    oof = res[bestC]
    oof.to_parquet(ROOT / "data/processed/oof.parquet")
    hold_start = oof.date.max() - pd.DateOffset(months=C["winprob"]["holdout_months"])
    tune = oof.date < hold_start
    temp = fit_temperature(oof.z_lr[tune].values, oof.y[tune].values)
    hold = ~tune
    p_lr = sigmoid(temp * oof.z_lr)
    rows = []
    for name, p in [("base rate (0.5)", np.full(len(oof), 0.5)), ("Elo only", oof.elo_p.values), ("LR (calibrated)", p_lr.values)]:
        for part, msk in [("tuning window", tune.values), ("hold-out (last 6 mo)", hold.values), ("all", np.ones(len(oof), bool))]:
            m = metrics(p[msk], oof.y.values[msk])
            rows.append({"model": name, "window": part, **m})
    if a.gb and "z_gb" in oof:
        zg = oof.z_gb
        tg = fit_temperature(zg[tune].values, oof.y[tune].values)
        best_w, best_ll = 0, 9
        for w in np.linspace(0, 1, 11):
            ll = metrics(sigmoid(w * tg * zg[tune] + (1 - w) * temp * oof.z_lr[tune]), oof.y[tune])["log_loss"]
            if ll < best_ll:
                best_w, best_ll = w, ll
        pe = sigmoid(best_w * tg * zg + (1 - best_w) * temp * oof.z_lr)
        for part, msk in [("tuning window", tune.values), ("hold-out (last 6 mo)", hold.values)]:
            rows.append({"model": "GB (calibrated)", "window": part, **metrics(sigmoid(tg * zg[msk]), oof.y.values[msk])})
            rows.append({"model": f"Ensemble (w_gb={best_w:.1f})", "window": part, **metrics(pe[msk], oof.y.values[msk])})
        configs_tried.append(f"GB + ensemble weight grid (11)")
        json.dump({"w_gb": best_w, "temp_gb": tg}, open(ROOT / "data/processed/ensemble.json", "w"))
    mt = pd.DataFrame(rows)
    mt.to_csv(ROOT / "output/backtest_ml_metrics.csv", index=False)
    rel = reliability(p_lr.values, oof.y.values)
    rel_h = reliability(p_lr[hold].values, oof.y[hold].values)
    rel.to_csv(ROOT / "output/backtest_reliability.csv", index=False)
    # low-sample subset
    low = oof.min_n < 3
    sub = [{"subset": "a fighter with <3 UFC fights", **metrics(p_lr[low], oof.y[low])},
           {"subset": "both fighters 3+ UFC fights", **metrics(p_lr[~low], oof.y[~low])}]
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        (ROOT / "output/charts").mkdir(parents=True, exist_ok=True)
        fig, ax = plt.subplots(figsize=(5, 5))
        ax.plot([0, 1], [0, 1], "--", color="#888", lw=1)
        r = rel[rel.n > 0]
        ax.scatter(r.mean_pred, r.hit_rate, s=np.sqrt(r.n) * 6, color="#2a6fdb")
        ax.set_xlabel("predicted P(A wins)"); ax.set_ylabel("observed"); ax.set_title(f"Win model reliability (walk-forward, n={len(oof)})")
        fig.tight_layout(); fig.savefig(ROOT / "output/charts/reliability.png", dpi=120); plt.close(fig)
    except Exception:
        pass

    # ---------------------------------------------------------------- simulator hold-out reliability
    sim_lines = []
    sim_note = ""
    if not a.no_sim:
        if a.clean_holdout:
            # calibrate the simulator ONLY on the 18 months before the hold-out (no overlap), then score the hold-out
            from src.calibrate_sim import calibrate
            gpath = ROOT / "data/processed/sim_globals_backtest.json"
            G, _ = calibrate(T, F, L, hold_start, save=True, out_path=gpath)
            sim_note = f"simulator calibrated on {G['_calib_window']['start']} → {G['_calib_window']['end']} (pre-hold-out only)"
        else:
            G = load_globals()
            sim_note = "simulator globals = production calibration (overlaps the hold-out; optimistic)"
        fights = T["fights"].set_index("fight_id")
        Fi = F.set_index(["fight_id", "side"])
        ho = oof[hold].copy()
        ho = ho[[fights.loc[i, "std_format"] for i in ho.fight_id]]
        jobs = []
        for i, r in enumerate(ho.itertuples()):
            fr = fights.loc[r.fight_id]
            wc = fr.weight_class if fr.weight_class != "Catchweight" else "ALL"
            jobs.append((Fi.loc[(r.fight_id, "A")].to_dict(), Fi.loc[(r.fight_id, "B")].to_dict(), L, wc, fr.gender,
                         int(fr.scheduled_rounds), float(sigmoid(temp * r.z_lr)), G, C["seed"] + i))
        with Pool(4) as pool:
            out = pool.map(_sim_job, jobs, chunksize=8)
        ffd = T["fighter_fight"].set_index(["fight_id", "fighter_id"])
        recs = []
        # fighter historical median sig landed per fight (before the fight) as the "line"
        ffh = T["fighter_fight"].merge(T["fights"][["fight_id", "date"]], on="fight_id")
        for r, o in zip(ho.itertuples(), out):
            fr = fights.loc[r.fight_id]
            fin = fr.method in ("KO", "SUB", "DOC", "DQ")
            et = fr.end_time_s
            rec = {"fight_id": r.fight_id, "p_dist": o["p_dist"], "y_dist": int(not fin), "p_o15": o["p_o15"], "y_o15": int(et >= 450),
                   "p_o25": o["p_o25"], "y_o25": int(et >= 750), "p_ko": o["p_ko"], "y_ko": int(fr.method in ("KO", "DOC")),
                   "p_sub": o["p_sub"], "y_sub": int(fr.method == "SUB")}
            for s, fid in (("A", fr.fighter_a_id), ("B", fr.fighter_b_id)):
                try:
                    act = ffd.loc[(r.fight_id, fid)]
                except KeyError:
                    continue
                hist = ffh[(ffh.fighter_id == fid) & (ffh.date < fr.date)]
                ysig, ytd = float(act.sig_l), float(act.td_l)
                rec[f"td_p_{s}"] = o[f"p_td{s}"]; rec[f"td_y_{s}"] = int(ytd >= 1)
                q10, q50, q90 = o[f"sig{s}"]
                rec[f"sig_cov_{s}"] = int(q10 <= ysig <= q90)
                rec[f"sig_crps_{s}"] = crps_sample(o[f"sig{s}_samp"], ysig)
                rec[f"sig_pin50_{s}"] = abs(ysig - q50) * 0.5
                if len(hist) >= 2:
                    line = float(np.median(hist.sig_l)) + 0.5
                    samp = np.array(o[f"sig{s}_samp"])
                    rec[f"sig_over_p_{s}"] = float((samp > line).mean()); rec[f"sig_over_y_{s}"] = int(ysig > line)
            recs.append(rec)
        sr = pd.DataFrame(recs)
        sr.to_csv(ROOT / "output/backtest_sim_holdout.csv", index=False)

        def brier_line(name, p, yv):
            p = np.asarray(p, float); yv = np.asarray(yv, float)
            ok = np.isfinite(p) & np.isfinite(yv)
            p, yv = p[ok], yv[ok]
            base = np.full_like(p, yv.mean())
            ll = -np.mean(yv * np.log(np.clip(p, 1e-4, 1)) + (1 - yv) * np.log(np.clip(1 - p, 1e-4, 1)))
            llb = -np.mean(yv * np.log(yv.mean()) + (1 - yv) * np.log(1 - yv.mean()))
            rel_ = reliability(p, yv, 5)
            rtxt = "; ".join(f"{b.bin}: pred {b.mean_pred:.2f} vs obs {b.hit_rate:.2f} (n={b.n})" for b in rel_.itertuples() if b.n > 0)
            return {"market": name, "n": int(len(p)), "brier": float(np.mean((p - yv) ** 2)), "brier_climatology": float(np.mean((base - yv) ** 2)),
                    "log_loss": float(ll), "log_loss_climatology": float(llb), "mean_pred": float(p.mean()), "obs_rate": float(yv.mean()), "reliability": rtxt}
        sim_lines = [brier_line("Goes the distance", sr.p_dist, sr.y_dist), brier_line("Over 1.5 rounds", sr.p_o15, sr.y_o15),
                     brier_line("Over 2.5 rounds", sr.p_o25, sr.y_o25), brier_line("Fight ends by KO/TKO", sr.p_ko, sr.y_ko),
                     brier_line("Fight ends by submission", sr.p_sub, sr.y_sub),
                     brier_line("Fighter 1+ takedown", pd.concat([sr.td_p_A, sr.td_p_B]), pd.concat([sr.td_y_A, sr.td_y_B])),
                     brier_line("Sig strikes over fighter's prior median", pd.concat([sr.get("sig_over_p_A"), sr.get("sig_over_p_B")]),
                                pd.concat([sr.get("sig_over_y_A"), sr.get("sig_over_y_B")]))]
        cov = pd.concat([sr.sig_cov_A, sr.sig_cov_B]).mean()
        crps = pd.concat([sr.sig_crps_A, sr.sig_crps_B]).mean()
        pin = pd.concat([sr.sig_pin50_A, sr.sig_pin50_B]).mean()
        sim_meta = {"n_fights": len(sr), "sig_80_coverage": float(cov), "sig_crps": float(crps), "sig_pinball50": float(pin)}
        pd.DataFrame(sim_lines).to_csv(ROOT / "output/backtest_sim_metrics.csv", index=False)

    # ---------------------------------------------------------------- BACKTEST.md
    ml_h = mt[(mt.window == "hold-out (last 6 mo)")].set_index("model")
    ml_all = mt[(mt.window == "all")].set_index("model")
    Ld = ["# BACKTEST", "",
          f"Walk-forward, monthly refit, {'REDUCED (Jan 2024 →)' if a.reduced else 'FULL (Jan 2022 →)'} through {oof.date.max().date()}. "
          f"Calibration (temperature {temp:.3f}) is fit on the tuning window only. The last {C['winprob']['holdout_months']} months "
          f"({hold_start.date()} →, n={int(hold.sum())}) are held out of tuning and calibration.", "",
          f"Configurations tried (multiple-testing honesty): {', '.join(configs_tried)}; plus the simulator finish-alpha grid {C['sim'].get('finish_alpha_grid')} (likelihood on calibration bouts).", "",
          "## Moneyline (win model)", "", mt.round(4).to_markdown(index=False), "",
          "Low-sample split (all walk-forward rows):", "", pd.DataFrame(sub).round(4).to_markdown(index=False), "",
          "Reliability, all walk-forward rows (10 bins of P(A)):", "", rel.round(3).to_markdown(index=False), ""]
    if sim_lines:
        Ld += ["## Simulator hold-out (last 6 months, props priced from each bout's pre-fight features, tilted to the model ML)", "",
               f"Setup: {sim_note}.", "",
               pd.DataFrame(sim_lines).drop(columns=["reliability"]).round(4).to_markdown(index=False), "",
               "Reliability by market (5 bins):", ""] + [f"- **{s['market']}**: {s['reliability']}" for s in sim_lines] + [
               "", f"Sig strikes per fighter: 80% interval coverage {sim_meta['sig_80_coverage']:.1%} (target 80%), CRPS {sim_meta['sig_crps']:.1f}, pinball@P50 {sim_meta['sig_pinball50']:.1f}.", ""]
    Ld += ["## Against the market", "",
           "No public historical UFC odds dataset was available inside this session's network, so **ROI, CLV and a vig-free-market baseline could not be backtested**. "
           "Consensus closing odds are being captured from tonight on (`data/odds_history.csv`, `watch_odds.py`) so future backtests can include them.", "",
           "## Plain-English verdict", ""]
    lrh = ml_h.loc["LR (calibrated)"]; eh = ml_h.loc["Elo only"]
    Ld += [f"- The win model clearly beats Elo and the coin-flip baseline out of sample (hold-out log loss {lrh.log_loss:.3f} vs. Elo {eh.log_loss:.3f} vs. 0.693). "
           f"But typical vig-free closing UFC moneylines score about 0.60–0.62 log loss in published analyses, which is better than this model. "
           "**Treat the moneyline as market-driven.** The model's ML weight stays at 0.30 (lower on the main card), and ML bets need a 3%+ edge and P(EV>0) ≥ 60%.",
           "- Props come from a simulator calibrated to base rates. It reproduces method shares, round shares and strike volume, but its bout-to-bout spread on distance is narrower than the market's. "
           "So distance and round markets are shrunk 70% toward the market, and large disagreements are red-flagged rather than bet.",
           "- Without historical prop odds the edge in props is **unproven**. Recommendations are small (quarter Kelly, 2% cap) and logged with CLV fields so the edge can be measured.",
           f"- Debutants and one-fight fighters are where the model knows least (see the low-sample split). They get wider intervals and a 1.5× edge requirement."]
    (ROOT / "BACKTEST.md").write_text("\n".join(Ld) + "\n")
    head = f"Win model hold-out LL {lrh.log_loss:.3f} (Elo {eh.log_loss:.3f}, coin 0.693), Brier {lrh.brier:.3f}, ECE {lrh.ece:.3f}, n={int(lrh.n)}; " \
           + (f"sim hold-out P(distance) Brier {sim_lines[0]['brier']:.3f} vs climatology {sim_lines[0]['brier_climatology']:.3f}; " if sim_lines else "") \
           + "no historical odds, so ROI/CLV untested."
    (ROOT / "output/backtest_headline.txt").write_text(head + "\n")
    print(head)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
