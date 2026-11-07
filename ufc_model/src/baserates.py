"""Base rates and sanity tables (§10), by weight class x gender (and 3 vs 5 rounds)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .util import ROOT


def fight_level(tables, min_year=2015) -> pd.DataFrame:
    f = tables["fights"]
    f = f[(f.date.dt.year >= min_year) & f.std_format & (f.result_type != "NC") & f.end_time_s.notna()].copy()
    ff = tables["fighter_fight"].groupby("fight_id").agg(
        sig_tot=("sig_l", "sum"), td_tot=("td_l", "sum"), tda_tot=("td_a", "sum"), kd_tot=("kd", "sum"),
        ctrl_tot=("ctrl_s", "sum"), sig_max=("sig_l", "max"), sig_min=("sig_l", "min")).reset_index()
    f = f.merge(ff, on="fight_id", how="left")
    f["finish"] = f.method.isin(["KO", "SUB", "DOC", "DQ"])
    f["mkt"] = np.select([f.method.isin(["KO", "DOC", "DQ"]), f.method == "SUB", f.result_type == "DRAW"],
                         ["KO", "SUB", "DRAW"], "DEC")
    f["minutes"] = f.end_time_s / 60
    return f


def tables_by_group(f: pd.DataFrame) -> dict[str, pd.DataFrame]:
    def agg(d):
        n = len(d)
        out = {"n": n, "finish_pct": d.finish.mean(), "ko_pct": (d.mkt == "KO").mean(),
               "sub_pct": (d.mkt == "SUB").mean(), "dec_pct": (d.mkt == "DEC").mean(), "draw_pct": (d.mkt == "DRAW").mean()}
        for r in range(1, 6):
            out[f"finish_r{r}"] = (d.finish & (d.end_round == r)).mean()
        out["median_min"] = d.minutes.median()
        out["sig_per_min_fighter"] = d.sig_tot.sum() / d.minutes.sum() / 2
        out["sig_tot_mean"] = d.sig_tot.mean(); out["sig_tot_p01"] = d.sig_tot.quantile(0.01)
        out["sig_tot_p99"] = d.sig_tot.quantile(0.99)
        out["td_per15"] = d.td_tot.sum() / d.minutes.sum() * 15 / 2
        out["tda_per15"] = d.tda_tot.sum() / d.minutes.sum() * 15 / 2
        out["ctrl_share"] = d.ctrl_tot.sum() / (d.minutes.sum() * 60)
        out["kd_per15"] = d.kd_tot.sum() / d.minutes.sum() * 15
        return pd.Series(out)

    res = {}
    res["by_division"] = f.groupby(["gender", "weight_class", "scheduled_rounds"]).apply(agg, include_groups=False).reset_index()
    res["by_gender_rounds"] = f.groupby(["gender", "scheduled_rounds"]).apply(agg, include_groups=False).reset_index()
    res["by_year"] = f.groupby(f.date.dt.year).apply(agg, include_groups=False).reset_index().rename(columns={"date": "year"})
    ev = None
    res["apex_vs_arena"] = f.assign(apex=f.event_id.isin(f.event_id)).pipe(lambda d: d)  # placeholder replaced below
    return res


def compute(tables, save=True) -> dict[str, pd.DataFrame]:
    f = fight_level(tables)
    f = f.merge(tables["events"][["event_id", "is_apex"]], on="event_id", how="left")
    res = tables_by_group(f)
    res["apex_vs_arena"] = f[f.date >= "2020-06-01"].groupby(["is_apex", "scheduled_rounds"]).apply(
        lambda d: pd.Series({"n": len(d), "finish_pct": d.finish.mean(), "ko_pct": (d.mkt == "KO").mean(),
                             "sig_per_min_fighter": d.sig_tot.sum() / d.minutes.sum() / 2}),
        include_groups=False).reset_index()
    if save:
        with pd.ExcelWriter(ROOT / "output/base_rates.xlsx") as xw:
            for k, v in res.items():
                v.to_excel(xw, sheet_name=k[:30], index=False)
    return res


def lookup(res, wc: str, gender: str, rounds: int) -> pd.Series:
    d = res["by_division"]
    m = d[(d.weight_class == wc) & (d.gender == gender) & (d.scheduled_rounds == rounds)]
    if len(m) and m.iloc[0]["n"] >= 25:
        return m.iloc[0]
    g = res["by_gender_rounds"]
    return g[(g.gender == gender) & (g.scheduled_rounds == rounds)].iloc[0]
