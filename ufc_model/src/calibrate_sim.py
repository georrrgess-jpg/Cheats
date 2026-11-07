"""Simulator calibration (§15): judging model fit + simulated method of moments on hazard scales.

Targets per weight group (M_low/M_mid/M_high/F): KO share, SUB share, decision share, finish-by-round
shares, mean combined sig strikes. Calibration bouts come from a window that excludes the hold-out
(last 6 months), and use each bout's own pre-fight features (no leakage).
"""
from __future__ import annotations

import json
import logging

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from .simulate import load_globals, make_params, simulate, group_of
from .util import ROOT, cfg

log = logging.getLogger("ufc.calib")


def fit_judging(tables, G: dict) -> dict:
    f = tables["fights"]
    f = f[(f.date.dt.year >= 2015) & f.method.isin(["U-DEC", "S-DEC", "M-DEC"]) | ((f.result_type == "DRAW") & (f.date.dt.year >= 2015))]
    ff = tables["fighter_fight"].set_index(["fight_id", "fighter_id"])
    rows = []
    for r in f.itertuples(index=False):
        try:
            a = ff.loc[(r.fight_id, r.fighter_a_id)]; b = ff.loc[(r.fight_id, r.fighter_b_id)]
        except KeyError:
            continue
        x = [a.sig_l - b.sig_l, a.kd - b.kd, a.td_l - b.td_l, (a.ctrl_s - b.ctrl_s) / 60.0, a.ground_l - b.ground_l]
        if np.any(pd.isna(x)):
            continue
        rows.append(x + [1 if r.winner_id == r.fighter_a_id else 0, r.result_type == "DRAW", r.method])
    d = pd.DataFrame(rows, columns=["sig", "kd", "td", "ctrl", "gr", "a_win", "draw", "method"])
    nd = d[~d.draw]
    X = nd[["sig", "kd", "td", "ctrl", "gr"]].values
    Xm = np.vstack([X, -X]); ym = np.concatenate([nd.a_win.values, 1 - nd.a_win.values])
    lr = LogisticRegression(fit_intercept=False, C=10, max_iter=1000).fit(Xm, ym)
    beta = lr.coef_[0]
    z = np.abs(d[["sig", "kd", "td", "ctrl", "gr"]].values @ beta)
    un = LogisticRegression(C=10).fit(z[~d.draw.values, None], (nd.method == "U-DEC").values)
    dr = LogisticRegression(C=10).fit(z[:, None], d.draw.values)
    nonun = nd[nd.method != "U-DEC"]
    G.update({"judge_beta": beta.tolist(), "unan_a": float(un.intercept_[0]), "unan_b": float(un.coef_[0][0]),
              "draw_a": float(dr.intercept_[0]), "draw_b": float(dr.coef_[0][0]),
              "majority_frac": float((nonun.method == "M-DEC").mean())})
    acc = np.mean((X @ beta > 0) == nd.a_win.values)
    log.info("judging model: beta=%s acc=%.3f n=%d", np.round(beta, 3), acc, len(nd))
    G["_judge_fit"] = {"n": int(len(d)), "accuracy": float(acc), "draw_rate": float(d.draw.mean()),
                       "unanimous_rate": float((nd.method == "U-DEC").mean())}
    return G


def calib_sample(tables, F, n_bouts: int, seed: int, end: pd.Timestamp, start: pd.Timestamp | None = None) -> pd.DataFrame:
    f = tables["fights"]
    start = start if start is not None else end - pd.DateOffset(months=18)
    f = f[(f.date >= start) & (f.date < end) & f.std_format & (f.result_type != "NC") & f.fighter_a_id.notna()
          & f.fighter_b_id.notna() & (f.method != "DQ")].copy()
    f["grp"] = [group_of(w, g) for w, g in zip(f.weight_class, f.gender)]
    rng = np.random.default_rng(seed)
    per = n_bouts // 4
    out = []
    for g, d in f.groupby("grp"):
        out.append(d.sample(min(per, len(d)), random_state=int(rng.integers(1e9))))
    s = pd.concat(out)
    feats = F.set_index(["fight_id", "side"])
    s = s[[(i, "A") in feats.index and (i, "B") in feats.index for i in s.fight_id]]
    return s


def actual_targets(s: pd.DataFrame, tables) -> pd.DataFrame:
    sig = tables["fighter_fight"].groupby("fight_id").sig_l.sum()
    ctrl = tables["fighter_fight"].groupby("fight_id").ctrl_s.sum()
    td = tables["fighter_fight"].groupby("fight_id").td_l.sum()
    s = s.assign(mk=np.select([s.method.isin(["KO", "DOC"]), s.method == "SUB"], ["KO", "SUB"], "DEC"),
                 sig_tot=s.fight_id.map(sig), ctrl_tot=s.fight_id.map(ctrl), td_tot=s.fight_id.map(td))
    rows = []
    for g, d in s.groupby("grp"):
        fin = d.mk != "DEC"
        rows.append({"grp": g, "n": len(d), "ko": (d.mk == "KO").mean(), "sub": (d.mk == "SUB").mean(),
                     "dec": (d.mk == "DEC").mean(), "r1": (fin & (d.end_round == 1)).mean(),
                     "r2": (fin & (d.end_round == 2)).mean(), "r3p": (fin & (d.end_round >= 3)).mean(),
                     "sig_tot": d.sig_tot.mean(), "ctrl_tot": d.ctrl_tot.mean(), "td_tot": d.td_tot.mean(),
                     "sig_fighter_sd": np.nan})
    return pd.DataFrame(rows).set_index("grp")


_FF = {}


def sim_targets(s, F, L_all, G, n_sims, seed) -> pd.DataFrame:
    feats = F.set_index(["fight_id", "side"])
    ffd = _FF.get("ffd")
    acc = {}
    LL, LLd = [], []
    COV, TDANY_S, TDANY_A = [], [], []
    for i, r in enumerate(s.itertuples(index=False)):
        sA = feats.loc[(r.fight_id, "A")].to_dict(); sB = feats.loc[(r.fight_id, "B")].to_dict()
        wc = r.weight_class if r.weight_class != "Catchweight" else "ALL"
        bp = make_params(sA, sB, L_all, wc, r.gender, r.scheduled_rounds, G)
        sim = simulate(bp, n_sims, seed + i, 0.0, G)
        m = sim["method"]
        fin = np.isin(m, ["KO", "SUB", "DOC"])
        mk_sim = np.where(np.isin(m, ["KO", "DOC"]), "KO", np.where(m == "SUB", "SUB", "DEC"))
        act_mk = "KO" if r.method in ("KO", "DOC") else ("SUB" if r.method == "SUB" else "DEC")
        LL.append(np.log(max((mk_sim == act_mk).mean(), 1e-3)))
        LLd.append(np.log(max(((~fin) if act_mk == "DEC" else fin).mean(), 1e-3)))
        if ffd is not None:
            for fid, arr, tarr in ((r.fighter_a_id, sim["sigA"], sim["tdA"]), (r.fighter_b_id, sim["sigB"], sim["tdB"])):
                if (r.fight_id, fid) in ffd.index:
                    act = ffd.loc[(r.fight_id, fid)]
                    q10, q90 = np.percentile(arr, [10, 90])
                    COV.append(float(q10 <= act.sig_l <= q90))
                    TDANY_S.append(float((tarr >= 1).mean())); TDANY_A.append(float(act.td_l >= 1))
        a = acc.setdefault(r.grp, {k: [] for k in ("ko", "sub", "dec", "r1", "r2", "r3p", "sig_tot", "ctrl_tot", "td_tot")})
        a["ctrl_tot"].append((sim["ctrlA"] + sim["ctrlB"]).mean()); a["td_tot"].append((sim["tdA"] + sim["tdB"]).mean())
        a["ko"].append(np.isin(m, ["KO", "DOC"]).mean()); a["sub"].append((m == "SUB").mean())
        a["dec"].append((~fin).mean())
        a["r1"].append((fin & (sim["end_round"] == 1)).mean()); a["r2"].append((fin & (sim["end_round"] == 2)).mean())
        a["r3p"].append((fin & (sim["end_round"] >= 3)).mean())
        a["sig_tot"].append((sim["sigA"] + sim["sigB"]).mean())
    out = pd.DataFrame({g: {k: float(np.mean(v)) for k, v in a.items()} for g, a in acc.items()}).T
    out.attrs["ll_method"] = float(np.mean(LL)); out.attrs["ll_dist"] = float(np.mean(LLd))
    out.attrs["sig_cov80"] = float(np.mean(COV)) if COV else np.nan
    out.attrs["td_any_sim"] = float(np.mean(TDANY_S)) if TDANY_S else np.nan
    out.attrs["td_any_act"] = float(np.mean(TDANY_A)) if TDANY_A else np.nan
    return out


def calibrate(tables, F, L_all, end: pd.Timestamp, save=True, out_path=None, start=None) -> tuple[dict, pd.DataFrame]:
    """Calibrate on bouts in [end - 18 months, end). Production: end = day after the latest event.
    Backtest hold-out check: end = hold-out start (no overlap)."""
    C = cfg()
    holdout_start = end
    from .simulate import DEFAULT_GLOBALS
    G = fit_judging(tables, json.loads(json.dumps(DEFAULT_GLOBALS)))
    _FF["ffd"] = tables["fighter_fight"].set_index(["fight_id", "fighter_id"])
    s = calib_sample(tables, F, C["sim"]["calib_bouts"], C["seed"], end, start)
    act = actual_targets(s, tables)
    hist = []
    f = tables["fights"]; f = f[(f.date >= "2020-01-01") & f.std_format & (f.result_type != "NC")]
    G["mu_fin"] = {g: {"ko": float(d.method.isin(["KO", "DOC"]).mean() / 2), "sub": float((d.method == "SUB").mean() / 2)}
                   for g, d in f.groupby("gender")}
    alpha_grid = C["sim"].get("finish_alpha_grid", [0.0])
    G["finish_alpha"] = 0.0
    for it in range(C["sim"]["calib_iters"]):
        if it == 2 and len(alpha_grid) > 1:      # after 2 scale iterations, pick alpha by likelihood
            best = None
            for a in alpha_grid:
                G["finish_alpha"] = a
                st_ = sim_targets(s, F, L_all, G, C["sim"]["calib_sims"], C["seed"] + 555)
                ll = st_.attrs["ll_method"]
                log.info("finish_alpha %.2f: LL(method) %.4f LL(dist) %.4f", a, ll, st_.attrs["ll_dist"])
                G.setdefault("_alpha_scan", {})[str(a)] = {"ll_method": ll, "ll_dist": st_.attrs["ll_dist"]}
                if best is None or ll > best[1]:
                    best = (a, ll)
            G["finish_alpha"] = best[0]
        sim = sim_targets(s, F, L_all, G, C["sim"]["calib_sims"], C["seed"] + 1000 * it)
        w = act["n"] / act["n"].sum()
        for j, k in enumerate(["r1", "r2", "r3p"]):
            ratio = float(np.clip((w * act[k]).sum() / max((w * sim[k]).sum(), 1e-3), 0.6, 1.6))
            if k == "r3p":
                G["round_haz"][2:] = [v * ratio for v in G["round_haz"][2:]]
            else:
                G["round_haz"][j] *= ratio
        G["escape_mult"] *= float(np.clip(((w * sim["ctrl_tot"]).sum() / (w * act["ctrl_tot"]).sum()), 0.6, 1.6))
        for g in act.index:
            if g not in sim.index:
                continue
            G["strike_scale"][g] *= float(np.clip(act.loc[g, "sig_tot"] / sim.loc[g, "sig_tot"], 0.6, 1.5))
            G["td_scale"][g] *= float(np.clip(act.loc[g, "td_tot"] / max(sim.loc[g, "td_tot"], 1e-3), 0.5, 2.0))
        # dispersion: grappling form sigma -> P(fighter lands 1+ TD); strike form sigma -> 80% coverage
        ta, ts = sim.attrs["td_any_act"], sim.attrs["td_any_sim"]
        if np.isfinite(ta) and np.isfinite(ts):
            G["grapple_sigma"] = float(np.clip(G["grapple_sigma"] * (ts / ta) ** 1.5, 0.2, 1.6))
        cov = sim.attrs["sig_cov80"]
        if np.isfinite(cov):
            G["form_sigma"] = float(np.clip(G["form_sigma"] * (1 + 1.5 * (0.80 - cov)), 0.15, 0.7))
        log.info("iter %d: td_any sim %.3f act %.3f -> grapple_sigma %.2f; sig cov80 %.3f -> form_sigma %.3f; dec %s",
                 it, ts, ta, G["grapple_sigma"], cov, G["form_sigma"], sim["dec"].round(3).to_dict())
        for g in act.index:
            if g not in sim.index:
                continue
            G["ko_scale"][g] *= float(np.clip((act.loc[g, "ko"] / max(sim.loc[g, "ko"], 1e-3)) ** 1.1, 0.5, 2.0))
            G["sub_scale"][g] *= float(np.clip((act.loc[g, "sub"] / max(sim.loc[g, "sub"], 1e-3)) ** 1.1, 0.5, 2.0))
        hist.append(sim.assign(iter=it))
        log.info("calib iter %d: sim KO %s / act %s", it, sim["ko"].round(3).to_dict(), act["ko"].round(3).to_dict())
    # 5-round fights: one scalar on all hazards, matched to the pooled 5-round decision share
    f5 = tables["fights"]
    f5 = f5[(f5.date >= "2019-01-01") & (f5.date < holdout_start) & f5.std_format & (f5.scheduled_rounds == 5)
            & (f5.result_type != "NC") & f5.fighter_a_id.notna() & f5.fighter_b_id.notna()].copy()
    f5["grp"] = [group_of(w, g) for w, g in zip(f5.weight_class, f5.gender)]
    feats = F.set_index(["fight_id", "side"])
    f5 = f5[[(i, "A") in feats.index and (i, "B") in feats.index for i in f5.fight_id]]
    f5 = f5.sample(min(160, len(f5)), random_state=C["seed"])
    act5 = 1 - f5.method.isin(["KO", "DOC", "SUB"]).mean()
    G["five_rd_haz"] = 1.0
    for it in range(4):
        st5 = sim_targets(f5, F, L_all, G, 1000, C["seed"] + 77 + it)
        sim5 = float((st5["dec"] * f5.grp.value_counts().reindex(st5.index).fillna(0)).sum() / len(f5))
        # more hazard -> fewer decisions; finish odds ratio adjustment
        ratio = ((1 - act5) / act5) / max((1 - sim5) / max(sim5, 1e-3), 1e-3)
        G["five_rd_haz"] *= float(np.clip(ratio ** 0.8, 0.6, 1.7))
        log.info("5-round calib: act dec %.3f sim dec %.3f -> five_rd_haz %.3f", act5, sim5, G["five_rd_haz"])
    G["_five_rd"] = {"n": int(len(f5)), "act_dec": float(act5), "sim_dec_last": sim5}
    final = sim_targets(s, F, L_all, G, C["sim"]["calib_sims"], C["seed"] + 99)
    comp = act.join(final, rsuffix="_sim")
    G["_final_ll"] = {"ll_method": final.attrs["ll_method"], "ll_dist": final.attrs["ll_dist"]}
    G["_calib_window"] = {"start": str(s.date.min().date()), "end": str(end.date()), "n_bouts": int(len(s))}
    G["_final_disp"] = {"sig_cov80": final.attrs["sig_cov80"], "td_any_sim": final.attrs["td_any_sim"], "td_any_act": final.attrs["td_any_act"]}
    if save:
        (out_path or ROOT / "data/processed/sim_globals.json").write_text(json.dumps(G, indent=1))
        comp.to_csv(ROOT / ("output/sim_calibration.csv" if out_path is None else "output/sim_calibration_backtest.csv"))
    return G, comp
