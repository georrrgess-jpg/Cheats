"""Best-bet analysis (§21): candidate pool, filters, composite score, lists, correlation control."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .devig import american_to_decimal, decimal_to_american, prob_to_american
from .edge import ev_per_dollar, logit, price_target, shrink, sig, weight_for
from .markets import outcome_vector, prob_of
from .odds import market_of


def describe_key(key: str, a: str, b: str) -> str:
    neg = key.startswith("NOT:")
    k = key[4:] if neg else key
    la, lb = a.split()[-1], b.split()[-1]
    nm = lambda s: la if s == "A" else lb if s == "B" else "Either fighter"
    p = k.split("|")
    h = p[0]
    try:
        if h == "ML":
            d = f"{nm(p[1])} ML"
        elif h == "DRAW":
            d = "Draw" if p[1] == "YES" else "No draw"
        elif h == "METHOD":
            s, m = p[1].split(":"); d = f"{nm(s)} by {dict(KO='KO/TKO', SUB='submission', DEC='decision')[m]}"
        elif h == "METHOD3":
            d = f"Fight ends by {p[1]}"
        elif h == "ITD":
            d = f"{nm(p[1])} inside the distance"
        elif h == "DIST":
            d = "Goes the distance" if p[1] == "YES" else "Doesn't go the distance"
        elif h == "ROUNDS_OU":
            d = f"{p[1].title()} {p[2]} rounds"
        elif h == "START_RD":
            d = f"Fight starts R{p[2]}"
        elif h == "END_RD":
            d = f"Fight ends in R{p[2]}"
        elif h == "ROUND":
            if p[1] == "DEC":
                d = "Goes to decision (round betting)"
            else:
                s, r = p[1].split(":"); d = f"{nm(s)} in {r}"
        elif h == "RD_METHOD":
            s, m, r = p[1].split(":"); d = f"{nm(s)} by {m} in {r}"
        elif h == "ROUND_GRP":
            s, g = p[1].split(":"); d = f"{nm(s)} {dict({'R1-2': 'in R1-2', 'R3-4': 'in R3-4', 'FINAL_OR_DEC': 'in final round or by decision'})[g]}"
        elif h == "DEC_TYPE":
            s, t = p[1].split(":"); d = f"{nm(s)} by {dict(U='unanimous', S='split', M='majority', SM='split/majority')[t]} decision"
        elif h == "SIG":
            who = "Combined" if p[1] == "TOT" else nm(p[1])
            d = f"{who} sig strikes {p[2].title()} {p[3]}"
        elif h == "TD":
            d = f"{nm(p[1])} takedowns {p[2].title()} {p[3]}"
        elif h == "KD":
            d = "Knockdown in the fight" if p[1] == "YES" else ("No knockdown" if p[1] == "NO" else f"{nm(p[1])} scores a knockdown")
        elif h in ("MOST_SIG", "MOST_TD"):
            d = f"{nm(p[1])} more {'sig strikes' if h == 'MOST_SIG' else 'takedowns'}"
        elif h == "TIME_OU":
            d = f"Fight time {p[1].title()} {p[2]} min"
        else:
            d = k
    except Exception:
        d = k
    return ("NOT: " + d) if neg else d


def build_candidates(bouts: list[dict], cons: pd.DataFrame, C: dict) -> pd.DataFrame:
    F = C["filters"]
    rows = []
    cons_by = {(r.bout_key, r.key): r for r in cons.itertuples()}
    for B in bouts:
        if B.get("excluded"):
            continue
        P = B["probs"]
        draws = B.get("boot", [])
        for (bk, key), q in cons_by.items():
            if bk != B["bout_key"]:
                continue
            p_win, p_push = prob_of(P, key)
            if not np.isfinite(p_win):
                continue
            mkt = q.market
            is_ml = mkt == "ML"
            cond = 1 - p_push if mkt in ("ML", "MOST_SIG", "MOST_TD") else 1.0
            p_model = p_win / cond               # ML: conditional on no draw
            if is_ml:                            # the win model's raw probability (the sim is tilted to p_final)
                p_model = B["p_model_ml"] if key == "ML|A" else 1 - B["p_model_ml"]
            w = weight_for(mkt, C, B["segment"], B["is_main_event"])
            p_final = shrink(p_model, q.p_fair, w)
            dec = american_to_decimal(q.median_american)
            ev = ev_per_dollar(p_final * cond, p_push, dec)
            # bootstrap
            if is_ml and B.get("ml_draws") is not None:
                pm = np.array(B["ml_draws"]) if key == "ML|A" else 1 - np.array(B["ml_draws"])
            elif draws:
                pm = np.array([prob_of(d, key)[0] / (1 - prob_of(d, key)[1] if cond < 1 else 1.0) for d in draws])
                pm = pm[np.isfinite(pm)]
            else:
                pm = np.array([p_model])
            pf_draws = sig(w * logit(np.clip(pm, 1e-4, 1 - 1e-4)) + (1 - w) * logit(q.p_fair))
            p_ev_pos = float(np.mean(ev_per_dollar(pf_draws * cond, p_push, dec) > 0))
            lo, hi = np.percentile(pf_draws, [10, 90]) if len(pf_draws) > 1 else (p_final, p_final)
            flags = []
            low_sample = B["low_sample"]
            if B["debut"]:
                flags.append("debutant")
            elif low_sample:
                flags.append("low sample")
            if B["short_notice"]:
                flags.append("short notice")
            red = abs(p_model - q.p_fair) > F["red_flag_gap"]
            if red:
                flags.append("RED FLAG: check news")
            if q.one_sided:
                flags.append("one-sided market")
            if q.n_two_sided <= 1:
                flags.append(f"thin market ({q.n_two_sided} two-sided book)")
            if B["tilt_flag"]:
                flags.append("large sim tilt")
            if q.outlier_books:
                flags.append(f"outlier price: {q.outlier_books}")
            edge = p_final - q.p_fair
            emin = F["edge_min"].get(mkt, 0.04) * (F["low_sample_edge_mult"] if (low_sample or B["debut"]) else 1.0)
            if q.n_two_sided == 1:
                emin *= F.get("thin_edge_mult", 1.0)
            reasons = []
            if ev <= 0: reasons.append("EV<=0")
            if edge < emin: reasons.append(f"edge<{emin:.1%}")
            if p_ev_pos < F["p_ev_pos_min"]: reasons.append("P(EV>0) low")
            if red: reasons.append("red flag")
            if B["tilt_flag"]: reasons.append("tilt")
            if q.n_two_sided < F["min_books"]: reasons.append("one-sided (no two-sided book)")
            if mkt in F["exclude_markets"]: reasons.append("exotic market")
            if q.median_american > F["max_price"]: reasons.append("long shot")
            if q.median_american < F["shortest_odds"] and ev < F["short_odds_ev_min"]: reasons.append("too short")
            if B.get("props_dropped") and mkt != "ML": reasons.append("sim check failed")
            dqw = 0.5 if B["debut"] else (0.75 if low_sample else 1.0)
            rows.append({
                "bout_order": B["bout_order"], "segment": B["segment"], "bout_key": B["bout_key"],
                "bout": f"{B['fighter_a']} vs {B['fighter_b']}", "key": key, "market": mkt,
                "bet": describe_key(key, B["fighter_a"], B["fighter_b"]), "line": q.line if hasattr(q, "line") else np.nan,
                "odds": q.median_american, "best_odds": q.best_american, "best_book": q.best_book, "n_books": q.n_books,
                "decimal": dec, "p_model": p_model, "p_fair": q.p_fair, "p_final": p_final, "p_push": p_push,
                "p_final_win": p_final * cond, "edge": edge, "ev": ev, "p_ev_pos": p_ev_pos, "p_lo": lo, "p_hi": hi,
                "hold": q.hold, "flags": "; ".join(flags), "fail": "; ".join(reasons), "passes": not reasons,
                "composite": ev * p_ev_pos * dqw, "w": w,
            })
    return pd.DataFrame(rows)


def dedupe_correlated(passing: pd.DataFrame, sims: dict, corr_max: float) -> pd.DataFrame:
    keep = []
    for bout, g in passing.sort_values("composite", ascending=False).groupby("bout_key", sort=False):
        chosen = []
        for r in g.itertuples():
            ok = True
            for c in chosen:
                sim = sims.get(bout)
                if sim is None:
                    continue
                a = outcome_vector(sim, r.key); b = outcome_vector(sim, c.key)
                if a is not None and b is not None and a.std() > 0 and b.std() > 0:
                    if abs(np.corrcoef(a, b)[0, 1]) > corr_max:
                        ok = False
                        break
            if ok:
                chosen.append(r)
        keep += [r.Index for r in chosen]
    return passing.loc[keep]


def price_targets(bouts: list[dict], cons: pd.DataFrame, C: dict) -> pd.DataFrame:
    """Every market/selection: model fair odds and minimum price to bet (works without odds)."""
    F = C["filters"]
    holds = cons.groupby("market").hold.median().to_dict() if len(cons) else {}
    rows = []
    include = ("ML|", "METHOD|", "METHOD3|", "ITD|", "DIST|", "ROUNDS_OU|", "START_RD|", "ROUND|", "SIG|", "TD|",
               "KD|", "DEC_TYPE|", "MOST_SIG|", "MOST_TD|", "ROUND_GRP|", "END_RD|", "TIME_OU|")
    for B in bouts:
        if B.get("excluded"):
            continue
        P = B["probs"]; draws = B.get("boot", [])
        for key in P:
            if not key.startswith(include) or key.startswith("PUSH"):
                continue
            mkt = market_of(key)
            p_win, push = prob_of(P, key)
            is_ml = mkt == "ML"
            cond = 1 - push if mkt in ("ML", "MOST_SIG", "MOST_TD") else 1.0
            pm = p_win / cond
            if is_ml:
                pm = B["p_model_ml"] if key == "ML|A" else 1 - B["p_model_ml"]
            if not (0.02 < pm < 0.98):
                continue
            w = weight_for(mkt, C, B["segment"], B["is_main_event"])
            if is_ml and B.get("ml_draws") is not None:
                dr = np.array(B["ml_draws"]) if key == "ML|A" else 1 - np.array(B["ml_draws"])
            else:
                dr = np.array([prob_of(d, key)[0] / ((1 - prob_of(d, key)[1]) if cond < 1 else 1.0) for d in draws]) if draws else np.array([pm])
            dr = np.clip(dr[np.isfinite(dr)], 1e-4, 1 - 1e-4)
            hold = holds.get(mkt, 0.045 if is_ml else 0.07)
            emin = F["edge_min"].get(mkt, 0.04) * (F["low_sample_edge_mult"] if (B["low_sample"] or B["debut"]) else 1.0)
            d_min = price_target(dr, pm, push, w, emin, F["p_ev_pos_min"], hold, cond < 1)
            rows.append({"bout_order": B["bout_order"], "segment": B["segment"], "bout_key": B["bout_key"],
                         "bout": f"{B['fighter_a']} vs {B['fighter_b']}", "market": mkt, "key": key,
                         "selection": describe_key(key, B["fighter_a"], B["fighter_b"]), "p_model": pm,
                         "fair_american": prob_to_american(pm),
                         "min_american_to_bet": (np.nan if not np.isfinite(d_min) else decimal_to_american(d_min)),
                         "p_push": push})
    return pd.DataFrame(rows)
