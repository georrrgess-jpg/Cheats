"""Turn joint simulated outcomes into probabilities for every market (§16).

Probability keys (internal, side 'A'/'B' = fighter_a/fighter_b of the card):
  ML|A  ML|B  DRAW|YES  METHOD|A:KO ... METHOD|B:DEC  METHOD3|KO|SUB|DEC  ITD|A  DIST|YES
  ROUND|A:R1 ... ROUND|DEC  ROUNDS_OU|OVER|2.5  START_RD|YES|2  END_RD|YES|1  TIME_OU|OVER|7.5
  SIG|A|OVER|55.5  SIG|TOT|OVER|110.5  TD|A|OVER|1.5  KD|YES  KD|A  DEC_TYPE|A:U  MOST_SIG|A
  RD_METHOD|A:KO:R1  RD_METHOD|ANY:KO:R1  ROUND_GRP|A:R1-2  ROUND_GRP|ANY:FINAL_OR_DEC ...
Any key can be negated with a 'NOT:' prefix (P = 1 - P(key) - P(push)).
"""
from __future__ import annotations

import numpy as np

from .clean import market_method


def _pmf(x: np.ndarray, cap: int = 400) -> np.ndarray:
    return np.bincount(np.clip(x.astype(int), 0, cap), minlength=cap + 1) / len(x)


def price_bout(sim: dict, book_rules: dict | None = None, sig_lines: dict | None = None,
               td_lines=(0.5, 1.5, 2.5, 3.5), grid_halfwidth: int = 30) -> dict:
    rules = book_rules or {}
    dq_ko = rules.get("dq_counts_as_ko", True)
    w, m, t, er, R = sim["winner"], sim["method"], sim["end_t"], sim["end_round"], sim["rounds"]
    mk = np.array([market_method(x, dq_ko) for x in m]) if False else np.where(
        np.isin(m, ["KO", "DOC"]), "KO", np.where(m == "SUB", "SUB", np.where(m == "DRAW", "DRAW", "DEC")))
    fin = np.isin(mk, ["KO", "SUB"])
    P = {}
    A, B, D = w == 0, w == 1, w == 2
    P["ML|A"], P["ML|B"], P["DRAW|YES"] = A.mean(), B.mean(), D.mean()
    P["DRAW|NO"] = 1 - P["DRAW|YES"]
    for s, S in (("A", A), ("B", B)):
        for k in ("KO", "SUB", "DEC"):
            P[f"METHOD|{s}:{k}"] = (S & (mk == k)).mean()
        P[f"ITD|{s}"] = (S & fin).mean()
        for typ, codes in (("U", ["U-DEC"]), ("S", ["S-DEC"]), ("M", ["M-DEC"]), ("SM", ["S-DEC", "M-DEC"])):
            P[f"DEC_TYPE|{s}:{typ}"] = (S & np.isin(m, codes)).mean()
        for r in range(1, R + 1):
            P[f"ROUND|{s}:R{r}"] = (S & fin & (er == r)).mean()
            for k in ("KO", "SUB"):
                P[f"RD_METHOD|{s}:{k}:R{r}"] = (S & (mk == k) & (er == r)).mean()
        P[f"ROUND_GRP|{s}:R1-2"] = (S & fin & (er <= 2)).mean()
        P[f"ROUND_GRP|{s}:R3-4"] = (S & fin & np.isin(er, [3, 4])).mean()
        P[f"ROUND_GRP|{s}:FINAL_OR_DEC"] = (S & ((fin & (er == R)) | (mk == "DEC"))).mean()
    P["METHOD3|KO"] = (mk == "KO").mean(); P["METHOD3|SUB"] = (mk == "SUB").mean()
    P["METHOD3|DEC"] = np.isin(mk, ["DEC", "DRAW"]).mean()
    P["DIST|YES"] = (~fin).mean(); P["DIST|NO"] = fin.mean()
    P["ROUND|DEC"] = (~fin).mean()
    for r in range(1, R + 1):
        P[f"END_RD|YES|{r}"] = (fin & (er == r)).mean()
        for k in ("KO", "SUB"):
            P[f"RD_METHOD|ANY:{k}:R{r}"] = ((mk == k) & (er == r)).mean()
    P["ROUND_GRP|ANY:R1-2"] = (fin & (er <= 2)).mean()
    P["ROUND_GRP|ANY:FINAL_OR_DEC"] = ((fin & (er == R)) | ~fin).mean()
    for x in [0.5, 1.5, 2.5, 3.5, 4.5]:
        if x < R:
            boundary = int(x) * 300 + 150
            P[f"ROUNDS_OU|OVER|{x}"] = (t >= boundary).mean()
            P[f"ROUNDS_OU|UNDER|{x}"] = 1 - P[f"ROUNDS_OU|OVER|{x}"]
    for n in range(2, R + 1):
        P[f"START_RD|YES|{n}"] = (t > (n - 1) * 300 + 1e-6).mean()
    for mins in (2.5, 5.0, 7.5, 10.0, 12.5, 15.0, 17.5, 20.0, 22.5):
        if mins * 60 < R * 300:
            P[f"TIME_OU|OVER|{mins}"] = (t > mins * 60).mean()
            P[f"TIME_OU|UNDER|{mins}"] = 1 - P[f"TIME_OU|OVER|{mins}"]
    # counts
    pmfs = {}
    summary = {}
    used_lines = {}
    for s, arr in (("A", sim["sigA"]), ("B", sim["sigB"]), ("TOT", sim["sigA"] + sim["sigB"])):
        pm = _pmf(arr, 600)
        pmfs[f"SIG|{s}"] = pm
        med = float(np.median(arr))
        if sig_lines is not None and s in sig_lines:
            lines = set(sig_lines[s])
        else:
            base = int(round(med))
            lines = {base + d + 0.5 for d in range(-grid_halfwidth, grid_halfwidth + 1, 5)}
        used_lines[s] = sorted(lines)
        for ln in sorted(lines):
            if ln < 0:
                continue
            over = (arr > ln).mean()
            push = (arr == ln).mean() if float(ln).is_integer() else 0.0
            P[f"SIG|{s}|OVER|{ln}"] = over
            P[f"SIG|{s}|UNDER|{ln}"] = 1 - over - push
            if push:
                P[f"PUSH|SIG|{s}|{ln}"] = push
        summary[f"sig_{s}_p10"], summary[f"sig_{s}_p50"], summary[f"sig_{s}_p90"] = np.percentile(arr, [10, 50, 90]).tolist()
        summary[f"sig_{s}_mean"] = float(arr.mean())
    for s, arr in (("A", sim["tdA"]), ("B", sim["tdB"])):
        pmfs[f"TD|{s}"] = _pmf(arr, 30)
        for ln in td_lines:
            P[f"TD|{s}|OVER|{ln}"] = (arr > ln).mean()
            P[f"TD|{s}|UNDER|{ln}"] = 1 - P[f"TD|{s}|OVER|{ln}"]
        summary[f"td_{s}_mean"] = float(arr.mean())
        summary[f"td_{s}_p_any"] = float((arr >= 1).mean())
    P["KD|YES"] = ((sim["kdA"] + sim["kdB"]) > 0).mean(); P["KD|NO"] = 1 - P["KD|YES"]
    P["KD|A"] = (sim["kdA"] > 0).mean(); P["KD|B"] = (sim["kdB"] > 0).mean()
    P["MOST_SIG|A"] = (sim["sigA"] > sim["sigB"]).mean(); P["MOST_SIG|B"] = (sim["sigB"] > sim["sigA"]).mean()
    P["MOST_SIG|TIE"] = 1 - P["MOST_SIG|A"] - P["MOST_SIG|B"]
    P["MOST_TD|A"] = (sim["tdA"] > sim["tdB"]).mean(); P["MOST_TD|B"] = (sim["tdB"] > sim["tdA"]).mean()
    P["MOST_TD|TIE"] = 1 - P["MOST_TD|A"] - P["MOST_TD|B"]
    summary.update({
        "sig_tot_mean": float((sim["sigA"] + sim["sigB"]).mean()), "median_time_s": float(np.median(t)),
        "p_distance": P["DIST|YES"], "kd_any": P["KD|YES"], "ctrl_A_mean": float(sim["ctrlA"].mean()),
        "ctrl_B_mean": float(sim["ctrlB"].mean()), "n_sims": int(sim["n"]),
        "survival": {f"{r}:{c}": float((t > (r - 1) * 300 + c).mean()) for r in range(1, R + 1) for c in (0, 150, 299)},
        "a_outlands": P["MOST_SIG|A"],
    })
    n = sim["n"]
    mcse = {k: float(np.sqrt(v * (1 - v) / n)) for k, v in P.items() if not k.startswith("PUSH")}
    return {"probs": {k: float(v) for k, v in P.items()}, "pmfs": pmfs, "summary": summary,
            "mcse_max": max(mcse.values()), "sig_lines": used_lines}


def prob_of(P: dict, key: str) -> tuple[float, float]:
    """(P(win), P(push)) for a selection key, handling NOT: and pushes, and ML draw-void."""
    neg = key.startswith("NOT:")
    k = key[4:] if neg else key
    if k not in P:
        return (np.nan, np.nan)
    push = 0.0
    if k.startswith("SIG|"):
        parts = k.split("|")
        push = P.get(f"PUSH|SIG|{parts[1]}|{parts[3]}", 0.0)
    if k.startswith("ML|"):
        push = P["DRAW|YES"]     # moneyline is void on a draw (default book rule)
    if neg:
        return (1 - P[k] - push, push)
    return (P[k], push)


def sim_correlation(sim: dict, key1: str, key2: str) -> float:
    """Correlation between two bet outcomes in the same bout from the joint sims (§21.5)."""
    a = outcome_vector(sim, key1); b = outcome_vector(sim, key2)
    if a is None or b is None or a.std() == 0 or b.std() == 0:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def outcome_vector(sim: dict, key: str):
    neg = key.startswith("NOT:")
    k = key[4:] if neg else key
    w, m, t, er, R = sim["winner"], sim["method"], sim["end_t"], sim["end_round"], sim["rounds"]
    mk = np.where(np.isin(m, ["KO", "DOC"]), "KO", np.where(m == "SUB", "SUB", np.where(m == "DRAW", "DRAW", "DEC")))
    fin = np.isin(mk, ["KO", "SUB"])
    side = lambda s: w == (0 if s == "A" else 1)
    p = k.split("|")
    v = None
    try:
        if p[0] == "ML":
            v = side(p[1])
        elif p[0] == "METHOD":
            s, mm = p[1].split(":"); v = side(s) & (mk == mm)
        elif p[0] == "ITD":
            v = side(p[1]) & fin
        elif p[0] == "DIST":
            v = ~fin if p[1] == "YES" else fin
        elif p[0] == "ROUNDS_OU":
            b = int(float(p[2])) * 300 + 150; v = (t >= b) if p[1] == "OVER" else (t < b)
        elif p[0] == "START_RD":
            v = t > (int(p[2]) - 1) * 300
        elif p[0] == "END_RD":
            v = fin & (er == int(p[2]))
        elif p[0] == "ROUND":
            if p[1] == "DEC":
                v = ~fin
            else:
                s, r = p[1].split(":"); v = side(s) & fin & (er == int(r[1:]))
        elif p[0] == "SIG":
            arr = sim["sigA"] if p[1] == "A" else sim["sigB"] if p[1] == "B" else sim["sigA"] + sim["sigB"]
            v = arr > float(p[3]) if p[2] == "OVER" else arr < float(p[3])
        elif p[0] == "TD":
            arr = sim["tdA"] if p[1] == "A" else sim["tdB"]
            v = arr > float(p[3]) if p[2] == "OVER" else arr < float(p[3])
        elif p[0] == "KD":
            v = (sim["kdA"] + sim["kdB"] > 0) if p[1] == "YES" else (sim["kdA"] > 0) if p[1] == "A" else (sim["kdB"] > 0)
        elif p[0] == "METHOD3":
            v = (mk == p[1]) if p[1] != "DEC" else ~fin
        elif p[0] == "DRAW":
            v = (w == 2) if p[1] == "YES" else (w != 2)
    except Exception:
        return None
    if v is None:
        return None
    v = v.astype(float)
    return 1 - v if neg else v
