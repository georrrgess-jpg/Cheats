"""Outputs (§24): xlsx workbook, report.md, predictions.json, handoff_summary.md, picks log, console."""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from .devig import fmt_american, prob_to_american
from .util import ROOT, cfg, now_utc

RESP = ("These are probability estimates, not guarantees. Stakes are suggestions inside the configured "
        "bankroll caps; bet only what you can afford to lose.")


def _pct(x):
    return "" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{100 * x:.1f}%"


def _bet_table(df: pd.DataFrame, C) -> pd.DataFrame:
    if df is None or not len(df):
        return pd.DataFrame(columns=["bout", "bet", "odds", "book", "p_model", "p_fair", "p_final", "edge", "ev", "p_ev_pos"])
    out = pd.DataFrame({
        "segment": df.segment, "bout": df.bout, "bet": df.bet, "market": df.market,
        "odds (median)": df.odds.map(fmt_american), "best odds": df.best_odds.map(fmt_american),
        "best book": df.best_book, "n books": df.n_books, "p_model": df.p_model, "p_fair": df.p_fair,
        "p_final": df.p_final, "edge": df.edge, "EV/$1": df.ev, "P(EV>0)": df.p_ev_pos,
        "p_final 80% lo": df.p_lo, "p_final 80% hi": df.p_hi,
    })
    if "stake_units" in df:
        out["stake (u)"] = df.stake_units
        out["stake ($)"] = df.stake_dollars
    out["flags"] = df.flags
    return out


def _write_sheet(xw, name, df, pct_cols=(), green_col=None):
    df.to_excel(xw, sheet_name=name, index=False)
    ws = xw.sheets[name]
    ws.freeze_panes = "A2"
    for c in ws[1]:
        c.font = Font(bold=True)
    for j, col in enumerate(df.columns, start=1):
        width = min(max([len(str(col))] + [len(str(v)) for v in df[col].head(200)]) + 2, 48)
        ws.column_dimensions[get_column_letter(j)].width = width
        if col in pct_cols:
            for row in ws.iter_rows(min_row=2, min_col=j, max_col=j):
                for c in row:
                    c.number_format = "0.0%"
    if green_col and green_col in df.columns and len(df):
        j = list(df.columns).index(green_col) + 1
        L = get_column_letter(j)
        rng = f"{L}2:{L}{len(df) + 1}"
        ws.conditional_formatting.add(rng, CellIsRule(operator="greaterThan", formula=["0"], fill=PatternFill("solid", fgColor="C6EFCE")))
        ws.conditional_formatting.add(rng, CellIsRule(operator="lessThan", formula=["0"], fill=PatternFill("solid", fgColor="FFC7CE")))


def _bout_label(B):
    return f"{B['fighter_a']} vs {B['fighter_b']}"


def write_all(o: dict, C: dict):
    ecfg = C["events"][o["event"]]
    bouts = [B for B in o["bouts"] if "probs" in B]
    rec, cand, pt, lists = o["rec"], o["cand"], o["pt"], o["lists"]
    PCT = ("p_model", "p_fair", "p_final", "edge", "EV/$1", "P(EV>0)", "p_final 80% lo", "p_final 80% hi",
           "P(model)", "P(fair)", "P(distance)", "p_push", "P(A wins)", "P(B wins)", "P(draw)")
    path = ROOT / f"output/{ecfg['output_prefix']}_model.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        # Best Bets
        parts = []
        for title, df in [("RECOMMENDED (staked)", rec), ("Best Value (top 5 EV)", lists["best_value"]),
                          ("Most Likely to Hit (+EV, all filters)", lists["most_likely"]),
                          ("Best Overall (composite)", lists["best_overall"]),
                          ("NEAR MISSES - not recommended (fail exactly one filter)", lists.get("near_misses", pd.DataFrame()))]:
            t = _bet_table(df.sort_values(["bout_order"]) if len(df) and title.startswith("REC") else df, C)
            hdr = pd.DataFrame([{t.columns[0] if len(t.columns) else "segment": f"== {title} =="}])
            parts += [hdr, t, pd.DataFrame([{}])]
        if len(rec):
            botn = rec.sort_values("composite", ascending=False).iloc[0]
            parts += [pd.DataFrame([{"segment": "== BET OF THE NIGHT ==", "bout": botn.bout, "bet": botn.bet,
                                     "odds (median)": fmt_american(botn.odds)}])]
        parts += [pd.DataFrame([{}]), pd.DataFrame([{"segment": "== PASS LIST =="}]),
                  pd.DataFrame([{"segment": "", "bout": b, "bet": r} for b, r in o["pass_list"]]),
                  pd.DataFrame([{}]), pd.DataFrame([{"segment": RESP}])]
        bb = pd.concat(parts, ignore_index=True)
        _write_sheet(xw, "Best Bets", bb, PCT, "EV/$1")
        # Price Targets
        ptt = pt.copy()
        if len(ptt):
            ptt = ptt.sort_values(["bout_order", "market", "key"])
            ptt["fair odds"] = ptt.fair_american.map(fmt_american)
            ptt["bet at or better than"] = ptt.min_american_to_bet.map(lambda x: fmt_american(x) if np.isfinite(x) else "no price qualifies")
            ptt = ptt[["segment", "bout", "market", "selection", "p_model", "fair odds", "bet at or better than", "p_push", "key"]]
            ptt = ptt.rename(columns={"p_model": "P(model)"})
        _write_sheet(xw, "Price Targets", ptt, PCT)
        # Card overview
        rows = []
        for B in o["bouts"]:
            if "probs" not in B:
                rows.append({"order": B["bout_order"], "segment": B["segment"], "bout": _bout_label(B), "status": "EXCLUDED"})
                continue
            P = B["probs"]
            rows.append({"order": B["bout_order"], "segment": B["segment"], "bout": _bout_label(B), "division": B["weight_class"],
                         "rounds": B["rounds"], "start (UTC)": B["start_time_utc"],
                         "P(A) model": B["p_model_ml"], "P(A) fair": B["p_fair_ml"], "P(A) final": B["p_final_ml"],
                         "A fair odds": fmt_american(prob_to_american(B["p_final_ml"])),
                         "market A odds (fair)": fmt_american(prob_to_american(B["p_fair_ml"])) if np.isfinite(B["p_fair_ml"]) else "n/a",
                         "A KO": P["METHOD|A:KO"], "A SUB": P["METHOD|A:SUB"], "A DEC": P["METHOD|A:DEC"],
                         "B KO": P["METHOD|B:KO"], "B SUB": P["METHOD|B:SUB"], "B DEC": P["METHOD|B:DEC"],
                         "P(distance)": P["DIST|YES"], "median fight time": f"{int(B['summary']['median_time_s'] // 60)}:{int(B['summary']['median_time_s'] % 60):02d}",
                         "sim tilt": B["tilt"], "flags": "; ".join(filter(None, ["debutant" if B["debut"] else "", "low sample" if B["low_sample"] else "",
                                                                             "short notice" if B["short_notice"] else "", "TILT" if B["tilt_flag"] else "",
                                                                             "props dropped" if B["props_dropped"] else "", B.get("note", "")]))})
        co = pd.DataFrame(rows)
        _write_sheet(xw, "Card Overview", co, PCT + ("P(A) model", "P(A) fair", "P(A) final", "A KO", "A SUB", "A DEC", "B KO", "B SUB", "B DEC"))
        # market sheets: every priced line (quoted ones with edges + all model lines)
        c = cand.copy() if len(cand) else pd.DataFrame(columns=["market"])
        groups = {"Moneyline": ["ML", "DRAW"], "Method": ["METHOD", "METHOD3", "ITD", "DEC_TYPE", "RD_METHOD"],
                  "Rounds": ["ROUNDS_OU", "DIST", "START_RD", "END_RD", "ROUND", "ROUND_GRP", "TIME_OU"],
                  "Sig Strikes": ["SIG_OU", "SIG_TOT_OU", "MOST_SIG"], "Takedowns": ["TD_OU", "MOST_TD"], "Other Props": ["KD"]}
        for sheet, mk in groups.items():
            q = c[c.market.isin(mk)] if len(c) else c
            q = _bet_table(q.sort_values(["bout_order", "key"]) if len(q) else q, C)
            if len(q):
                q["passes filters"] = c.loc[c.market.isin(mk)].sort_values(["bout_order", "key"]).passes.values
                q["why not"] = c.loc[c.market.isin(mk)].sort_values(["bout_order", "key"]).fail.values
            mp = pt[pt.market.isin(mk)] if len(pt) else pt
            if len(mp):
                extra = mp[["bout", "selection", "p_model", "fair_american", "min_american_to_bet"]].rename(
                    columns={"selection": "bet", "p_model": "p_model"})
                extra["odds (median)"] = "no quote"
                extra["fair"] = extra.fair_american.map(fmt_american)
                extra["bet at or better"] = extra.min_american_to_bet.map(lambda x: fmt_american(x) if np.isfinite(x) else "n/a")
                extra = extra.drop(columns=["fair_american", "min_american_to_bet"])
                quoted = set(zip(q.bout, q.bet)) if len(q) else set()
                extra = extra[[(b, s) not in quoted for b, s in zip(extra.bout, extra.bet)]]
                q = pd.concat([q, pd.DataFrame([{"bout": "== model-only lines (no quote) =="}]), extra], ignore_index=True)
            _write_sheet(xw, sheet, q, PCT, "EV/$1")
        # Fighter profiles
        prof = []
        for B in bouts:
            for s in ("A", "B"):
                sn = B[f"snap{s}"]
                prof.append({"bout": _bout_label(B), "fighter": B[f"fighter_{s.lower()}"], "UFC fights": sn["n_fights"],
                             "UFC minutes": round(sn["ufc_minutes"], 1), "record (UFC)": f"{sn['wins']}-{sn['losses']}",
                             "Elo": round(sn["elo"]), "Elo RD": round(sn["elo_rd"]), "age": round(sn["age"], 1) if np.isfinite(sn["age"]) else None,
                             "height": sn["height"], "reach": sn["reach"], "stance": sn["stance"],
                             "stand sig off (x avg)": sn["off_stand_l"], "stand sig absorbed (x avg)": sn["def_stand_l"],
                             "TD att (x avg)": sn["off_td_a"], "TD acc (x avg)": sn["off_td_l"], "TD def: opp acc (x avg)": sn["def_td_l"],
                             "control/TD (x avg)": sn["off_ctrl"], "sub threat (x avg)": sn["off_sub_att"],
                             "KD power (x avg)": sn["off_kd"], "KD absorbed (chin, x avg)": sn["def_kd"],
                             "cardio R3/R1 (x avg)": sn["cardio"], "KO losses (3y)": sn["ko_losses_3y"],
                             "layoff days": sn["layoff_days"], "head share": sn["share_head"],
                             "rate SE (approx, stand sig)": 1 / np.sqrt(sn.get("effn_stand_l", 0) + 10)})
        _write_sheet(xw, "Fighter Profiles", pd.DataFrame(prof))
        # Sim distributions
        sd = []
        for B in bouts:
            sm = B["summary"]
            row = {"bout": _bout_label(B), "sims": sm["n_sims"], "MC SE max": B["mcse_max"]}
            for s, nm in (("A", B["fighter_a"]), ("B", B["fighter_b"]), ("TOT", "combined")):
                row[f"sig {s} P10/P50/P90"] = f"{sm[f'sig_{s}_p10']:.0f} / {sm[f'sig_{s}_p50']:.0f} / {sm[f'sig_{s}_p90']:.0f}"
            row["TD A mean"] = sm["td_A_mean"]; row["TD B mean"] = sm["td_B_mean"]
            row["P(KD)"] = sm["kd_any"]
            for k, v in sm["survival"].items():
                row[f"alive R{k}"] = v
            sd.append(row)
        _write_sheet(xw, "Sim Distributions", pd.DataFrame(sd))
        # Line movement (from odds history)
        try:
            h = pd.read_csv(ROOT / "data/odds_history.csv")
            h = h[h.key.isin(["ML|A", "ML|B"]) | h.key.str.startswith("ROUNDS_OU") | h.key.str.startswith("DIST")]
            lm = h.groupby(["bout_key", "key", "book"]).agg(open=("american", "first"), current=("american", "last"),
                                                           first_seen=("snapshot_ts", "first"), last_seen=("snapshot_ts", "last")).reset_index()
            lm["move"] = lm.current - lm.open
            _write_sheet(xw, "Line Movement", lm)
        except Exception:
            pass
        # Data quality + backtest
        dq = (ROOT / "output/data_quality.md").read_text().splitlines() if (ROOT / "output/data_quality.md").exists() else []
        _write_sheet(xw, "Data Quality", pd.DataFrame({"data quality report": dq}))
        bt = (ROOT / "BACKTEST.md").read_text().splitlines() if (ROOT / "BACKTEST.md").exists() else ["backtest not run yet"]
        _write_sheet(xw, "Backtest Summary", pd.DataFrame({"BACKTEST.md": bt}))
    try:
        write_charts(o, C)
    except Exception as e:  # charts are optional (T2)
        import logging
        logging.getLogger("ufc.report").warning("charts failed: %s", e)
    write_predictions(o, C)
    write_report(o, C)
    write_handoff(o, C)
    append_picks(o, C)


def write_predictions(o, C):
    out = {"run_id": o["run_id"], "event": o["event"], "generated_utc": now_utc().isoformat(), "bouts": []}
    for B in o["bouts"]:
        d = {k: v for k, v in B.items() if k not in ("boot", "snapA", "snapB", "pmfs")}
        if "snapA" in B:
            d["snapA"] = {k: (v if not isinstance(v, float) or np.isfinite(v) else None) for k, v in B["snapA"].items() if not k.startswith("effn")}
            d["snapB"] = {k: (v if not isinstance(v, float) or np.isfinite(v) else None) for k, v in B["snapB"].items() if not k.startswith("effn")}
            d["pmfs"] = B["pmfs"]
        out["bouts"].append(d)
    out["recommended"] = o["rec"].to_dict("records") if len(o["rec"]) else []
    out["price_targets"] = o["pt"].to_dict("records") if len(o["pt"]) else []

    def clean(x):
        if isinstance(x, dict):
            return {str(k): clean(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [clean(v) for v in x]
        if isinstance(x, (np.floating, float)):
            return None if not np.isfinite(x) else float(x)
        if isinstance(x, (np.integer,)):
            return int(x)
        if isinstance(x, (np.bool_,)):
            return bool(x)
        if isinstance(x, pd.Timestamp):
            return x.isoformat()
        return x
    (ROOT / "output/predictions.json").write_text(json.dumps(clean(out), indent=1, default=str))


def _bet_line(r):
    st = f" | stake {r.stake_units:.1f}u" if "stake_units" in r._fields else ""
    return (f"| {r.bout} | {r.bet} | {fmt_american(r.odds)} (best {fmt_american(r.best_odds)} {r.best_book}) | "
            f"{_pct(r.p_model)} | {_pct(r.p_fair)} | {_pct(r.p_final)} | {100*r.edge:+.1f} pts | {r.ev:+.3f} | {_pct(r.p_ev_pos)}{st} | {r.flags} |")


def bet_case(r, B, pt: pd.DataFrame) -> list[str]:
    """Bet of the Night case, 5 lines or fewer."""
    sm = B["summary"]
    tgt = pt[(pt.bout_key == r.bout_key) & (pt.key == r.key)]
    thr = fmt_american(tgt.min_american_to_bet.iloc[0]) if len(tgt) and np.isfinite(tgt.min_american_to_bet.iloc[0]) else "n/a"
    drv = ", ".join(f"{k} ({v:+.2f} logit)" for k, v in B["driver_vals"].items())
    return [f"1. Model {_pct(r.p_final)} (raw {_pct(r.p_model)}) vs market {_pct(r.p_fair)} at {fmt_american(r.odds)}; EV {r.ev:+.3f}/$1, P(EV>0) {_pct(r.p_ev_pos)}.",
            f"2. Hits in {_pct(r.p_model)} of {sm['n_sims']:,} sims. Goes the distance in {_pct(sm['p_distance'])}; median combined sig strikes {sm['sig_TOT_p50']:.0f} (P10 {sm['sig_TOT_p10']:.0f}, P90 {sm['sig_TOT_p90']:.0f}).",
            f"3. Win-model drivers: {drv}.",
            f"4. Main risk: {r.flags or 'variance; a single exchange can flip a fight'}.",
            f"5. No longer a bet at worse than {thr}."]


def write_report(o, C):
    rec, bouts = o["rec"], [B for B in o["bouts"] if "probs" in B]
    bymap = {B["bout_key"]: B for B in bouts}
    L = [f"# {o['event']}: model report", "", f"Run `{o['run_id']}` {o.get('release','')} · generated {now_utc().strftime('%Y-%m-%d %H:%M UTC')}", "",
         f"> {RESP}", "", "## Best bets (prelims first, in bout order)", "",
         "| Bout | Bet | Odds | Model | Fair | Final | Edge | EV/$1 | P(EV>0) / stake | Flags |", "|---|---|---|---|---|---|---|---|---|---|"]
    L += [_bet_line(r) for r in rec.itertuples()] if len(rec) else ["| — | No bet clears every filter | | | | | | | | |"]
    if len(rec):
        b = rec.sort_values("composite", ascending=False).iloc[0]
        L += ["", f"### Bet of the Night: {b.bet} ({b.bout}) at {fmt_american(b.odds)}"] + bet_case(b, bymap[b.bout_key], o["pt"])
    nm = o["lists"].get("near_misses")
    if nm is not None and len(nm):
        L += ["", "## Near misses (NOT recommended; each fails exactly one filter)", "",
              "| Bout | Bet | Odds | Model | Fair | Final | Edge | EV/$1 | P(EV>0) | Fails | Flags |", "|---|---|---|---|---|---|---|---|---|---|---|"]
        L += [f"| {r.bout} | {r.bet} | {fmt_american(r.odds)} | {_pct(r.p_model)} | {_pct(r.p_fair)} | {_pct(r.p_final)} | {100*r.edge:+.1f} | {r.ev:+.3f} | {_pct(r.p_ev_pos)} | {r.fail} | {r.flags} |" for r in nm.itertuples()]
    L += ["", "## Pass list"] + [f"- {k}: {r}" for k, r in o["pass_list"]]
    L += ["", "## Bout breakdowns"]
    for B in bouts:
        P, sm = B["probs"], B["summary"]
        la, lb = B["fighter_a"].split()[-1], B["fighter_b"].split()[-1]
        fl = "; ".join(filter(None, ["debutant" if B["debut"] else "", "low sample" if B["low_sample"] else "", "short notice" if B["short_notice"] else "",
                                     "large tilt" if B["tilt_flag"] else "", B.get("note", "")]))
        L += [f"### {B['bout_order']}. {B['fighter_a']} vs {B['fighter_b']} ({B['weight_class']}, {B['rounds']} rds, {B['segment']})",
              f"- Moneyline: model {la} {_pct(B['p_model_ml'])}, market (vig-free) {_pct(B['p_fair_ml'])}, final {_pct(B['p_final_ml'])} (fair {fmt_american(prob_to_american(B['p_final_ml']))}). Elo alone: {_pct(B['elo_p'])}.",
              f"- Method: {la} KO {_pct(P['METHOD|A:KO'])} / SUB {_pct(P['METHOD|A:SUB'])} / DEC {_pct(P['METHOD|A:DEC'])}; {lb} KO {_pct(P['METHOD|B:KO'])} / SUB {_pct(P['METHOD|B:SUB'])} / DEC {_pct(P['METHOD|B:DEC'])}.",
              f"- Goes the distance in {_pct(P['DIST|YES'])} of sims; median fight time {int(sm['median_time_s']//60)}:{int(sm['median_time_s']%60):02d}; {la} out-lands {lb} in {_pct(sm['a_outlands'])}; combined sig strikes median {sm['sig_TOT_p50']:.0f} (P10 {sm['sig_TOT_p10']:.0f}, P90 {sm['sig_TOT_p90']:.0f}).",
              f"- Top win-model drivers: {', '.join(f'{k} ({v:+.2f})' for k, v in B['driver_vals'].items())}. Sim tilt {B['tilt']:+.2f}.",
              f"- Risks/flags: {fl or 'none'}." + (f" Checks: {B['checks_failed'] + B['bounds_flags']}" if B['props_dropped'] else "")]
    d = o["disagreements"]
    L += ["", "## Biggest model vs. market disagreements (reviewed before recommending)", "", "| Bout | Selection | Model | Market | Gap | Note |", "|---|---|---|---|---|---|"]
    for r in d.itertuples():
        L.append(f"| {r.bout} | {r.bet} | {_pct(r.p_model)} | {_pct(r.p_fair)} | {100*abs(r.p_model-r.p_fair):.1f} pts | {'RED FLAG' if abs(r.p_model-r.p_fair) > C['filters']['red_flag_gap'] else ''} {r.fail[:60]} |")
    L += ["", "## Caveats",
          "- UFC moneylines are sharp. The model's ML weight is only 0.30 (lower on the main card), so ML picks are rare by design.",
          "- Sig-strike, takedown and knockdown props have no quotes yet. See the Price Targets sheet for fair prices and minimum prices to bet.",
          "- Debutants and one-fight fighters use priors plus a light sample. Their intervals are wide and need a stricter edge.",
          "- Line shopping is off (no books given): EV uses the median price across the books on BestFightOdds; the best price is shown for reference.",
          f"- {RESP}"]
    (ROOT / "output/report.md").write_text("\n".join(L) + "\n")


def write_handoff(o, C):
    rec = o["rec"]
    bouts = [B for B in o["bouts"] if "probs" in B]
    L = [f"# Handoff: {o['event']} ({o.get('release','')}, run {o['run_id']})", "",
         "Card (A vs B | P(A) model / market / final | P(dist)):"]
    for B in bouts:
        L.append(f"- {B['bout_order']:>2} {B['segment'][:4]} {B['fighter_a']} vs {B['fighter_b']} | {_pct(B['p_model_ml'])} / {_pct(B['p_fair_ml'])} / {_pct(B['p_final_ml'])} | {_pct(B['probs']['DIST|YES'])}"
                 + (" | DEBUT" if B['debut'] else "") + (" | SN" if B['short_notice'] else ""))
    L += ["", "Best bets (median odds; model/fair/final; EV; P(EV>0); stake):"]
    for r in rec.itertuples():
        L.append(f"- {r.bout}: {r.bet} {fmt_american(r.odds)} | {_pct(r.p_model)}/{_pct(r.p_fair)}/{_pct(r.p_final)} | EV {r.ev:+.3f} | {_pct(r.p_ev_pos)} | {r.stake_units:.1f}u | {r.flags}")
    if not len(rec):
        L.append("- none qualify")
        nm = o["lists"].get("near_misses")
        if nm is not None and len(nm):
            L.append("Near misses (not recommended):")
            L += [f"- {r.bout}: {r.bet} {fmt_american(r.odds)} | {_pct(r.p_model)}/{_pct(r.p_fair)}/{_pct(r.p_final)} | fails: {r.fail}" for r in nm.head(5).itertuples()]
    pt = o["pt"]
    if len(pt):
        top = pt[pt.market.isin(["DIST", "ROUNDS_OU", "SIG_TOT_OU", "SIG_OU", "TD_OU"])].copy()
        top = top[np.isfinite(top.min_american_to_bet) & ~top.key.str.startswith("NOT:")]
        top = top[top.market.isin(["SIG_OU", "SIG_TOT_OU", "TD_OU"])]
        top = top.assign(d=(top.p_model - 0.5).abs()).sort_values("d").groupby(["bout_key", "market"]).head(1)
        top = top.sort_values(["bout_order", "market"]).head(14)
        L += ["", "Price targets, lines nearest the sim median (fair → bet at or better; full list in the Price Targets sheet):"]
        for r in top.itertuples():
            L.append(f"- {r.bout}: {r.selection} fair {fmt_american(r.fair_american)} → {fmt_american(r.min_american_to_bet)}")
    bt = ROOT / "output/backtest_headline.txt"
    L += ["", "Backtest: " + (bt.read_text().strip() if bt.exists() else "see BACKTEST.md")]
    flags = [f"{B['bout_key']}: " + ", ".join(filter(None, ["debut" if B['debut'] else "", "short notice" if B['short_notice'] else "",
                                                             "tilt" if B['tilt_flag'] else "", "props dropped" if B['props_dropped'] else ""]))
             for B in bouts if B['debut'] or B['short_notice'] or B['tilt_flag'] or B['props_dropped']]
    L += ["", "Flags:"] + [f"- {f}" for f in flags] + ["", RESP]
    (ROOT / "output/handoff_summary.md").write_text("\n".join(L[:60]) + "\n")


def append_picks(o, C):
    rec = o["rec"]
    path = ROOT / "data/picks_log.csv"
    cols = ["run_id", "release", "timestamp", "event", "bout_key", "bout", "market", "selection_key", "selection", "line", "odds",
            "book", "p_model", "p_fair", "p_final", "edge", "ev", "p_ev_pos", "stake_units", "placed_odds", "closing_odds", "result", "pnl"]
    if not len(rec):
        if not path.exists():
            pd.DataFrame(columns=cols).to_csv(path, index=False)
        return
    df = pd.DataFrame({"run_id": o["run_id"], "release": o.get("release", ""), "timestamp": now_utc().isoformat(), "event": o["event"],
                       "bout_key": rec.bout_key, "bout": rec.bout, "market": rec.market, "selection_key": rec.key, "selection": rec.bet,
                       "line": rec.line, "odds": rec.odds.round(0), "book": "median/consensus (best: " + rec.best_book.astype(str) + ")",
                       "p_model": rec.p_model.round(4), "p_fair": rec.p_fair.round(4), "p_final": rec.p_final.round(4),
                       "edge": rec.edge.round(4), "ev": rec.ev.round(4), "p_ev_pos": rec.p_ev_pos.round(3),
                       "stake_units": rec.stake_units, "placed_odds": "", "closing_odds": "", "result": "", "pnl": ""})
    df.to_csv(path, mode="a", header=not path.exists(), index=False)


def console(o):
    rec = o["rec"]
    print("\n=== BEST BETS", o["event"], o["run_id"], "===")
    if not len(rec):
        print("No bet clears every filter.")
    for r in rec.itertuples():
        print(f"{r.segment:6s} {r.bout[:34]:34s} {r.bet[:34]:34s} {fmt_american(r.odds):>6s}  model {100*r.p_final:5.1f}%  fair {100*r.p_fair:5.1f}%  EV {r.ev:+.3f}  P+ {100*r.p_ev_pos:4.0f}%  {r.stake_units:.1f}u")
    print(f"(pipeline {o['elapsed']:.0f}s)")


def write_charts(o, C):
    """Finish-time survival curves per bout and combined sig-strike distributions (T2, §24)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    d = ROOT / "output/charts"
    d.mkdir(parents=True, exist_ok=True)
    bouts = [B for B in o["bouts"] if "probs" in B]
    fig, axes = plt.subplots(int(np.ceil(len(bouts) / 4)), 4, figsize=(16, 3.2 * np.ceil(len(bouts) / 4)), squeeze=False)
    for ax, B in zip(axes.ravel(), bouts):
        sim = o.get("sims", {}).get(B["bout_key"])
        if sim is None:
            continue
        t = np.sort(sim["end_t"]) / 60
        grid = np.linspace(0, B["rounds"] * 5, 200)
        surv = 1 - np.searchsorted(t, grid, side="right") / len(t)
        ax.plot(grid, surv, color="#2a6fdb")
        for r in range(1, B["rounds"]):
            ax.axvline(5 * r, color="#ccc", lw=0.8)
        ax.set_ylim(0, 1); ax.set_title(f"{B['bout_key']}", fontsize=9)
        ax.set_xlabel("minutes", fontsize=8); ax.set_ylabel("P(fight still going)", fontsize=8)
    for ax in axes.ravel()[len(bouts):]:
        ax.axis("off")
    fig.tight_layout(); fig.savefig(d / "survival_curves.png", dpi=110); plt.close(fig)
    fig, axes = plt.subplots(int(np.ceil(len(bouts) / 4)), 4, figsize=(16, 3.2 * np.ceil(len(bouts) / 4)), squeeze=False)
    for ax, B in zip(axes.ravel(), bouts):
        sim = o.get("sims", {}).get(B["bout_key"])
        if sim is None:
            continue
        tot = sim["sigA"] + sim["sigB"]
        ax.hist(tot, bins=60, color="#7a5af8", alpha=0.85)
        ax.set_title(f"{B['bout_key']}: combined sig (median {np.median(tot):.0f})", fontsize=9)
    for ax in axes.ravel()[len(bouts):]:
        ax.axis("off")
    fig.tight_layout(); fig.savefig(d / "sig_strike_distributions.png", dpi=110); plt.close(fig)
