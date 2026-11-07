"""Consensus fair prices, market shrinkage, edge/EV and price targets (§17, §18, §24 Price Targets)."""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .devig import american_to_decimal, decimal_to_american, devig, implied, one_sided_fair, prob_to_american
from .markets import prob_of
from .odds import market_of

log = logging.getLogger("ufc.edge")


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def sig(z):
    return 1 / (1 + np.exp(-z))


def shrink(p_model, p_fair, w):
    if p_fair is None or not np.isfinite(p_fair):
        return p_model
    return float(sig(w * logit(p_model) + (1 - w) * logit(p_fair)))


def weight_for(market: str, C: dict, segment: str, is_main_event: bool) -> float:
    w = C["shrink"].get(market, 0.4)
    if is_main_event:
        w *= C["shrink"]["main_event_mult"]
    elif segment == "main":
        w *= C["shrink"]["main_card_mult"]
    return w


def consensus(quotes: pd.DataFrame, C: dict) -> pd.DataFrame:
    """Per (bout, key): consensus vig-free probability, median & best price, hold, flags."""
    dv = C["devig"]
    per = []
    for (bout, grp, book), g in quotes.groupby(["bout_key", "group", "book"]):
        keys = list(g["key"]); prices = list(g["american"])
        if len(keys) >= 2:
            try:
                fair, hold = devig(prices, two_way=dv["two_way"], multi_way=dv["multi_way"])
            except Exception:
                continue
            for k, f, a in zip(keys, fair, prices):
                per.append([bout, k, book, a, f, hold, False])
        else:
            per.append([bout, keys[0], book, prices[0], one_sided_fair(prices[0], dv["one_sided_margin"]),
                        dv["one_sided_margin"], True])
    per = pd.DataFrame(per, columns=["bout_key", "key", "book", "american", "fair", "hold", "one_sided"])
    rows = []
    for (bout, key), g in per.groupby(["bout_key", "key"]):
        two = g[~g.one_sided]
        use = two if len(two) else g
        med_fair = float(use.fair.median())
        dec = g.american.map(american_to_decimal)
        best_i = dec.idxmax()
        outl = list(g.loc[(g.fair - med_fair).abs() > dv["outlier_prob_gap"], "book"])
        rows.append({"bout_key": bout, "key": key, "market": market_of(key), "p_fair": med_fair,
                     "n_books": int(len(g)), "n_two_sided": int(len(two)), "one_sided": len(two) == 0,
                     "hold": float(use.hold.median()), "median_american": decimal_to_american(float(dec.median())),
                     "best_american": float(g.loc[best_i, "american"]), "best_book": g.loc[best_i, "book"],
                     "books": ",".join(sorted(g.book)), "outlier_books": ",".join(outl)})
    return pd.DataFrame(rows), per


def ev_per_dollar(p_win, p_push, dec):
    return p_win * (dec - 1) - (1 - p_win - p_push)


def price_target(p_model_draws: np.ndarray, p_model: float, push: float, w: float, edge_min: float,
                 p_ev_min: float, hold: float, is_ml: bool) -> float:
    """Worst (lowest) decimal price at which the bet still clears edge_min and P(EV>0) >= p_ev_min.
    p_fair at a hypothetical price = implied(price) minus half the typical hold (two-way market).
    Edge after shrinkage is NOT monotonic in price (it falls again at extreme long odds), so scan from
    the fair price outward in 0.5-pt implied-probability steps, then bisect between the last failing
    and first passing grid points."""
    cond = 1 - push if is_ml else 1.0
    zd = logit(np.clip(p_model_draws, 1e-4, 1 - 1e-4))

    def ok(d):
        pf = float(np.clip(1 / d - hold / 2, 1e-4, 0.9999))
        pfin = shrink(p_model, pf, w)
        if pfin - pf < edge_min or ev_per_dollar(pfin * cond, push, d) <= 0:
            return False
        pf_draws = sig(w * zd + (1 - w) * logit(pf))
        return float(np.mean(ev_per_dollar(pf_draws * cond, push, d) > 0)) >= p_ev_min

    q0 = min(0.995, p_model * cond + hold / 2 + 0.005)
    prev = 1.0 / q0
    for q in np.arange(q0, 0.005, -0.005):
        d = 1.0 / q
        if ok(d):
            lo, hi = prev, d
            for _ in range(25):
                mid = 0.5 * (lo + hi)
                if ok(mid):
                    hi = mid
                else:
                    lo = mid
            return hi
        prev = d
    return float("nan")
