"""Quarter-Kelly staking with per-bet, per-bout and per-card caps (§21.6)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def kelly_fraction(p_win: float, p_push: float, dec: float) -> float:
    """Full-Kelly fraction for a bet that can push: maximize p log(1+bf) + q log(1-f). Closed form
    ignoring the push outcome's zero return: f* = (b p - q) / b with q = 1 - p - push."""
    b = dec - 1.0
    q = 1.0 - p_win - p_push
    if b <= 0:
        return 0.0
    return max(0.0, (b * p_win - q) / b)


def stake(bets: pd.DataFrame, S: dict) -> pd.DataFrame:
    """bets needs p_final_win, p_push, decimal, bout_key. Adds stake_frac, stake_units, stake_dollars."""
    b = bets.copy()
    if b.empty:
        for c in ("kelly_full", "stake_frac", "stake_units", "stake_dollars"):
            b[c] = []
        return b
    b["kelly_full"] = [kelly_fraction(p, q, d) for p, q, d in zip(b.p_final_win, b.p_push, b.decimal)]
    f = (b.kelly_full * S["kelly_fraction"]).clip(upper=S["max_bet_frac"])
    # per-bout cap: scale down proportionally
    for bout, idx in b.groupby("bout_key").groups.items():
        tot = f.loc[idx].sum()
        if tot > S["max_bout_frac"]:
            f.loc[idx] *= S["max_bout_frac"] / tot
    tot = f.sum()
    if tot > S["max_card_frac"]:
        f *= S["max_card_frac"] / tot
    units = np.floor(f * S["bankroll_units"] / S["round_units"] + 1e-9) * S["round_units"]
    b["stake_frac"] = f
    b["stake_units"] = units.round(1)
    ud = S.get("unit_dollars")
    b["stake_dollars"] = (b.stake_units * ud).round(2) if ud else np.nan
    return b
