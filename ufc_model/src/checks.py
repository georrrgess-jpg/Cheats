"""Data validation (§9) and pre-output sanity checks (§23). Failures raise or drop markets with flags."""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .util import ROOT

log = logging.getLogger("ufc.checks")


class CheckFailed(Exception):
    pass


def validate_data(tables, event_date: str) -> tuple[list[str], list[str]]:
    """Returns (errors, warnings). Errors block the run."""
    errs, warns = [], []
    fr, ff, fights, fz = tables["fight_rounds"], tables["fighter_fight"], tables["fights"], tables["fighters"]
    for a, b in [("sig_l", "sig_a"), ("total_l", "total_a"), ("td_l", "td_a"), ("head_l", "head_a"),
                 ("dist_l", "dist_a"), ("clinch_l", "clinch_a"), ("ground_l", "ground_a")]:
        bad = (fr[a] > fr[b]).sum()
        if bad:
            errs.append(f"{bad} round rows with {a} > {b}")
    num = fr.select_dtypes("number")
    neg = (num < 0).sum().sum()
    if neg:
        errs.append(f"{neg} negative stat values")
    # per-round sums consistency: head+body+leg == sig, dist+clinch+ground == sig
    d1 = (fr.head_l + fr.body_l + fr.leg_l - fr.sig_l).abs()
    d2 = (fr.dist_l + fr.clinch_l + fr.ground_l - fr.sig_l).abs()
    if (d1 > 1).mean() > 0.001 or (d2 > 1).mean() > 0.001:
        errs.append(f"target/position splits disagree with sig totals in {(d1>1).sum()}/{(d2>1).sum()} rows")
    elif (d1 > 0).sum() + (d2 > 0).sum():
        warns.append(f"{(d1>0).sum()+(d2>0).sum()} rows with off-by-one target/position splits (tolerated)")
    # control time within round time
    over = (fr.ctrl_s > fr.round_time_s + 1).sum()
    if over:
        warns.append(f"{over} rounds with control time > round time")
    # rounds-with-stats vs end_round
    chk = fights.merge(fr.groupby("fight_id")["round"].max().rename("max_r"), on="fight_id", how="inner")
    mism = (chk.max_r != chk.end_round).sum()
    if mism:
        warns.append(f"{mism} fights where per-round stats do not reach the end round")
    # time consistency
    t = fights[fights.std_format & fights.end_round.notna()]
    implied = (t.end_round - 1) * 300 + t.end_clock_s
    if (implied - t.end_time_s).abs().max() > 1:
        errs.append("total fight time inconsistent with end round/time")
    if (t.end_clock_s > 300).sum():
        errs.append(f"{(t.end_clock_s > 300).sum()} fights with end clock > 5:00")
    if fights.fight_id.duplicated().any():
        errs.append("duplicate fight ids")
    if fz.fighter_id.duplicated().any():
        errs.append("duplicate fighter ids")
    dupb = fr.duplicated(["fight_id", "round", "fighter_id"]).sum()
    if dupb:
        errs.append(f"{dupb} duplicate fight-round-fighter rows")
    # freshness: latest completed event should be within 14 days before the event date
    last = fights.date.max()
    ed = pd.Timestamp(event_date)
    if (ed - last).days > 14 or last >= ed:
        errs.append(f"stale data: latest event {last.date()} vs event {ed.date()}")
    # plausible row counts per event
    per_ev = fights.groupby("event_id").size()
    recent = fights[fights.date >= ed - pd.Timedelta(days=400)].groupby("event_id").size()
    if (recent < 5).any():
        warns.append(f"{(recent < 5).sum()} recent events with < 5 fights")
    missing_id = fights.fighter_a_id.isna().sum() + fights.fighter_b_id.isna().sum()
    if missing_id:
        warns.append(f"{missing_id} fighter slots with no fighter id (name missing from fighter table); excluded")
    return errs, warns


def write_data_quality(tables, errs, warns, extra: dict, path=None):
    fights, fz = tables["fights"], tables["fighters"]
    lines = ["# Data quality report", "",
             f"- Fights: {len(fights)} ({fights.date.min().date()} → {fights.date.max().date()}); events: {len(tables['events'])}",
             f"- Fight-round rows: {len(tables['fight_rounds'])}; fighters: {len(fz)}",
             f"- Results: {fights.result_type.value_counts().to_dict()}",
             f"- Methods: {fights.method.value_counts().to_dict()}",
             f"- Fighters missing reach: {fz.reach_in.isna().sum()}; missing height: {fz.height_in.isna().sum()}; missing DOB: {fz.dob.isna().sum()}",
             "", "## Errors (block the run)"] + ([f"- {e}" for e in errs] or ["- none"]) + [
             "", "## Warnings"] + ([f"- {w}" for w in warns] or ["- none"]) + ["", "## Exclusions and imputations",
             "- No contests and overturned results: minutes/stats kept for rates, excluded from outcome models.",
             "- DQ: a win for Elo/ML; excluded from finish-hazard calibration targets (KO bucket for markets, configurable per book).",
             "- Doctor stoppage / could not continue: KO/TKO bucket for markets, own small hazard in the simulator.",
             "- Pre-2010 fights: Elo only. Non-standard round formats: Elo only.",
             "- Missing DOB: the age feature is set to 0 difference (no guess). Missing reach: the reach difference is 0 with a missing flag (no imputation in T1)."]
    for k, v in extra.items():
        lines += ["", f"## {k}"] + [f"- {x}" for x in (v if isinstance(v, list) else [v])]
    (path or ROOT / "output/data_quality.md").write_text("\n".join(lines) + "\n")


# ------------------------------------------------------------------ §23 checks on priced markets
def check_bout_markets(m: dict, p_final_ml: float, tol=0.001) -> list[str]:
    """m = market dict for one bout (from markets.price_bout). Returns list of failures."""
    fails = []
    P = m["probs"]
    for k, v in P.items():
        if not (0 <= v <= 1):
            fails.append(f"prob out of range {k}={v}")
    meth = [P[f"METHOD|{s}:{t}"] for s in ("A", "B") for t in ("KO", "SUB", "DEC")]
    s6 = sum(meth) + P["DRAW|YES"]
    if abs(s6 - 1) > tol:
        fails.append(f"6-way method + draw sums to {s6:.4f}")
    for s in ("A", "B"):
        tot = sum(P[f"METHOD|{s}:{t}"] for t in ("KO", "SUB", "DEC"))
        if abs(tot - P[f"ML|{s}"]) > tol:
            fails.append(f"method sum for {s} {tot:.4f} != ML {P[f'ML|{s}']:.4f}")
    dec = P["METHOD|A:DEC"] + P["METHOD|B:DEC"] + P["DRAW|YES"]
    if abs(P["DIST|YES"] - dec) > tol:
        fails.append(f"P(distance) {P['DIST|YES']:.4f} != P(dec)+P(draw) {dec:.4f}")
    ou = [P[k] for k in sorted(k for k in P if k.startswith("ROUNDS_OU|OVER|"))]
    if any(np.diff(ou) > 1e-9):
        fails.append("rounds over-probabilities not monotonic")
    for s in ("A", "B", "TOT"):
        ks = sorted((float(k.split("|")[3]), P[k]) for k in P if k.startswith(f"SIG|{s}|OVER|"))
        if any(np.diff([v for _, v in ks]) > 1e-9):
            fails.append(f"sig strike over-curve for {s} not non-increasing")
    if abs(P["ML|A"] + P["ML|B"] + P["DRAW|YES"] - 1) > tol:
        fails.append("ML + draw do not sum to 1")
    return fails


def check_sim_bounds(m: dict, br_row) -> list[str]:
    fl = []
    med = m["summary"]["sig_tot_mean"]
    lo, hi = br_row.get("sig_tot_p01", 0), br_row.get("sig_tot_p99", 400)
    if not (lo <= med <= hi):
        fl.append(f"mean combined sig strikes {med:.0f} outside historical 1–99% [{lo:.0f}, {hi:.0f}]")
    return fl
