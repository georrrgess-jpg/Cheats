"""Odds conversions and vig removal (§17)."""
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import brentq


def american_to_decimal(a: float) -> float:
    a = float(a)
    if a == 0 or not math.isfinite(a):
        raise ValueError(f"bad american odds {a}")
    return 1 + (a / 100.0 if a > 0 else 100.0 / -a)


def decimal_to_american(d: float) -> float:
    if not math.isfinite(d) or d <= 1:
        return float("nan")
    return (d - 1) * 100.0 if d >= 2 else -100.0 / (d - 1)


def implied(a: float) -> float:
    return 1.0 / american_to_decimal(a)


def prob_to_american(p: float) -> float:
    if not (0 < p < 1):
        return float("nan")
    return decimal_to_american(1.0 / p)


def fmt_american(a: float) -> str:
    if a is None or not math.isfinite(a):
        return "n/a"
    a = round(a)
    return f"+{a}" if a > 0 else f"{a}"


# ------------------------------------------------------------------ devig methods (input: implied probs)
def multiplicative(q):
    q = np.asarray(q, float)
    return q / q.sum()


def additive(q):
    q = np.asarray(q, float)
    p = q - (q.sum() - 1) / len(q)
    return np.clip(p, 1e-6, 1)


def power(q):
    q = np.asarray(q, float)
    if abs(q.sum() - 1) < 1e-12:
        return q
    k = brentq(lambda k: np.sum(q ** k) - 1, 0.01, 100)
    return q ** k


def shin(q):
    """Shin (1993) via the standard closed form for z, solved numerically."""
    q = np.asarray(q, float)
    S = q.sum()
    if abs(S - 1) < 1e-12:
        return q
    n = len(q)

    def probs(z):
        return (np.sqrt(z * z + 4 * (1 - z) * q * q / S) - z) / (2 * (1 - z))

    z = brentq(lambda z: probs(z).sum() - 1, 0.0, 0.999) if S > 1 else 0.0
    p = probs(z)
    return p / p.sum()


def odds_ratio(q):
    q = np.asarray(q, float)

    def probs(c):
        return q / (c + q - c * q)

    c = brentq(lambda c: probs(c).sum() - 1, 0.01, 100)
    return probs(c)


METHODS = {"multiplicative": multiplicative, "additive": additive, "power": power, "shin": shin,
           "odds_ratio": odds_ratio}


def devig(american_list, method: str | None = None, two_way="power", multi_way="shin"):
    q = [implied(a) for a in american_list]
    m = method or (two_way if len(q) == 2 else multi_way)
    return METHODS[m](q), sum(q) - 1.0       # (fair probs, hold/overround)


def one_sided_fair(american: float, margin: float) -> float:
    """Fair prob for a one-sided market using an assumed overround (multiplicative)."""
    return implied(american) / (1 + margin)
