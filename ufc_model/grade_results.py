#!/usr/bin/env python
"""Post-event grading and review (§26).

  python grade_results.py --event "UFC Vegas 124"

1. Re-download the UFCStats dataset (it includes the event once it has been scraped); results from the
   data store are the source of truth.
2. Grade every logged bet (win / loss / push / void) under the default book rules, compute P&L in units.
3. CLV vs data/closing_lines.csv (vig-free closing prob - vig-free prob at the price taken).
4. Running calibration table across graded events (output/calibration_running.csv).
5. output/review_<event>.md. Never retunes the model off one card.
"""
from __future__ import annotations

import argparse
import pickle

import numpy as np
import pandas as pd

from src.devig import american_to_decimal, implied
from src.markets import outcome_vector
from src.names import norm
from src.scrape_card import load_card
from src.store import build_tables
from src.util import ROOT, cfg


def actual_outcomes(T, card, event_date):
    f = T["fights"][T["fights"].date == pd.Timestamp(event_date)]
    ff = T["fighter_fight"].set_index(["fight_id", "fighter_id"])
    out = {}
    for r in card.itertuples():
        m = f[((f.fighter_a_id == r.a_id) & (f.fighter_b_id == r.b_id)) | ((f.fighter_a_id == r.b_id) & (f.fighter_b_id == r.a_id))]
        if not len(m):
            continue
        x = m.iloc[0]
        g = lambda fid, c: float(ff.loc[(x.fight_id, fid), c]) if (x.fight_id, fid) in ff.index else np.nan
        w = 2 if x.result_type == "DRAW" else (0 if x.winner_id == r.a_id else 1)
        if x.result_type == "NC":
            w = -1
        out[r.bout_key] = {"winner": np.array([w]), "method": np.array([x.method if x.result_type != "DRAW" else "DRAW"]),
                           "end_t": np.array([x.end_time_s]), "end_round": np.array([int(x.end_round)]),
                           "sigA": np.array([g(r.a_id, "sig_l")]), "sigB": np.array([g(r.b_id, "sig_l")]),
                           "tdA": np.array([g(r.a_id, "td_l")]), "tdB": np.array([g(r.b_id, "td_l")]),
                           "kdA": np.array([g(r.a_id, "kd")]), "kdB": np.array([g(r.b_id, "kd")]),
                           "rounds": int(r.scheduled_rounds), "n": 1, "nc": x.result_type == "NC"}
    return out


def grade_one(key, o, line=None):
    if o.get("nc"):
        return "void"
    k = key[4:] if key.startswith("NOT:") else key
    if k.startswith("ML|") and o["winner"][0] == 2:
        return "push"
    if k.startswith("SIG|"):
        p = k.split("|")
        v = o["sigA"][0] if p[1] == "A" else o["sigB"][0] if p[1] == "B" else o["sigA"][0] + o["sigB"][0]
        if float(p[3]).is_integer() and v == float(p[3]):
            return "push"
    v = outcome_vector(o, key)
    if v is None:
        return "ungradable"
    return "win" if v[0] == 1 else "loss"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", default="UFC Vegas 124")
    ap.add_argument("--no-refresh", action="store_true")
    a = ap.parse_args(argv)
    C = cfg()
    ecfg = C["events"][a.event]
    if not a.no_refresh:
        from src.store import fetch_dataset
        fetch_dataset(force=True)
    T = build_tables()
    st = pickle.load(open(ROOT / f"data/processed/cache_{ecfg['output_prefix']}.pkl", "rb"))
    card = st["card"]
    res = actual_outcomes(T, card, ecfg["date"])
    picks = pd.read_csv(ROOT / "data/picks_log.csv")
    picks = picks[picks.event == a.event]
    # grade each bet once: keep the latest logged row per selection (re-runs append the same pick again)
    picks = picks.drop_duplicates(["bout_key", "selection_key"], keep="last")
    if not len(res):
        print("Event not in the dataset yet (it usually appears within a day). Re-run later.")
        return 1
    closing = pd.read_csv(ROOT / "data/closing_lines.csv") if (ROOT / "data/closing_lines.csv").exists() else pd.DataFrame()
    rows = []
    for r in picks.itertuples():
        o = res.get(r.bout_key)
        g = grade_one(r.selection_key, o) if o else "pending"
        price = r.placed_odds if isinstance(r.placed_odds, (int, float)) and np.isfinite(r.placed_odds) else r.odds
        dec = american_to_decimal(price)
        pnl = {"win": r.stake_units * (dec - 1), "loss": -r.stake_units, "push": 0.0, "void": 0.0}.get(g, np.nan)
        clv = np.nan
        if len(closing):
            c = closing[(closing.bout_key == r.bout_key) & (closing.key == r.selection_key)]
            if len(c):
                clv = float(c.p_fair.iloc[0]) - float(r.p_fair)
        pct = np.nan
        sims = st["sims"].get(r.bout_key)
        if sims is not None and o is not None and r.selection_key.lstrip("NOT:").startswith("SIG|"):
            p = r.selection_key.lstrip("NOT:").split("|")
            arr = sims["sigA"] if p[1] == "A" else sims["sigB"] if p[1] == "B" else sims["sigA"] + sims["sigB"]
            act = o["sigA"][0] if p[1] == "A" else o["sigB"][0] if p[1] == "B" else o["sigA"][0] + o["sigB"][0]
            pct = float((arr < act).mean())
        rows.append({**r._asdict(), "result": g, "pnl": pnl, "clv": clv, "sim_percentile": pct})
    gr = pd.DataFrame(rows).drop(columns=["Index"])
    allp = pd.read_csv(ROOT / "data/picks_log.csv")
    for col in ("result", "pnl", "closing_odds"):
        allp[col] = allp[col].astype(object)
    for r in gr.itertuples():
        msk = (allp.event == a.event) & (allp.bout_key == r.bout_key) & (allp.selection_key == r.selection_key)
        allp.loc[msk, "result"] = r.result
        allp.loc[msk, "pnl"] = r.pnl
        if len(closing):
            c = closing[(closing.bout_key == r.bout_key) & (closing.key == r.selection_key)]
            if len(c):
                allp.loc[msk, "closing_odds"] = c.median_american.iloc[0]
    allp.to_csv(ROOT / "data/picks_log.csv", index=False)
    done = gr[gr.result.isin(["win", "loss"])]
    exp_w = done.p_final.sum()
    cal = ROOT / "output/calibration_running.csv"
    new = done.assign(event=a.event)[["event", "market", "p_final", "result"]]
    old = pd.read_csv(cal) if cal.exists() else pd.DataFrame(columns=new.columns)
    cr = pd.concat([old[old.event != a.event], new], ignore_index=True)
    cr.to_csv(cal, index=False)
    L = [f"# Review: {a.event}", "",
         f"- Graded {len(done)} bets: {int((done.result == 'win').sum())} won vs. {exp_w:.1f} expected; P&L {gr.pnl.sum():+.2f} units on {gr.stake_units.sum():.1f} staked.",
         f"- Mean CLV {gr.clv.mean():+.3f} (vig-free prob points; positive = beat the close)." if gr.clv.notna().any() else "- CLV: no closing lines captured.",
         f"- Small sample: {len(done)} bets cannot separate skill from luck. Model changes wait for {C['grading']['min_bets_before_retune']}+ graded bets (CHANGELOG.md).", "",
         "| Bout | Bet | Odds | p_final | Result | P&L | CLV | Actual in sim (pctile) | Read |", "|---|---|---|---|---|---|---|---|---|"]
    for r in gr.itertuples():
        read = ("good bet, lost" if r.result == "loss" and (r.clv if np.isfinite(r.clv) else 0) >= 0 else
                "bet lost and the line moved against it" if r.result == "loss" else "won" if r.result == "win" else r.result)
        L.append(f"| {r.bout} | {r.selection} | {r.odds:+.0f} | {r.p_final:.1%} | {r.result} | {r.pnl:+.2f} | {r.clv:+.3f} | "
                 f"{'' if not np.isfinite(r.sim_percentile) else f'{r.sim_percentile:.0%}'} | {read} |")
    (ROOT / f"output/review_{a.event.replace(' ', '_')}.md").write_text("\n".join(L) + "\n")
    print("\n".join(L[:5]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
