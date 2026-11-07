"""Features for a fight never use that fight or anything later (§11.1, §27)."""
import numpy as np
import pandas as pd
import pytest
from src.store import build_tables
from src.features import build_features, league_rates


@pytest.fixture(scope="module")
def T():
    return build_tables()


def test_no_leakage(T):
    L = league_rates(T, 2020)
    fights = T["fights"]
    # pick a fighter with many fights; cut history at a fight, recompute, compare pre-fight snapshot
    fid = "c21f26bbde777573"      # Johnny Walker
    fs = fights[(fights.fighter_a_id == fid) | (fights.fighter_b_id == fid)].sort_values("date")
    target = fs.iloc[len(fs) // 2]
    F_full, _, _, _, _ = build_features(T, L)
    row_full = F_full[(F_full.fight_id == target.fight_id) & (F_full.fighter_id == fid)].iloc[0]
    # truncated world: drop the target fight's results AND everything after it
    T2 = dict(T)
    keep = fights[fights.date < target.date].fight_id
    T2["fights"] = pd.concat([fights[fights.fight_id.isin(keep)], fights[fights.fight_id == target.fight_id].assign(
        winner_id=None, result_type="NC", method="OTHER")])
    T2["fighter_fight"] = T["fighter_fight"][T["fighter_fight"].fight_id.isin(keep)]
    T2["fight_rounds"] = T["fight_rounds"][T["fight_rounds"].fight_id.isin(keep)]
    F_cut, _, _, _, _ = build_features(T2, L)
    row_cut = F_cut[(F_cut.fight_id == target.fight_id) & (F_cut.fighter_id == fid)].iloc[0]
    for c in ["elo", "off_stand_l", "def_stand_l", "off_td_a", "off_kd", "n_fights", "ufc_minutes", "wins", "cardio"]:
        assert row_full[c] == pytest.approx(row_cut[c], rel=1e-9, abs=1e-9), c


def test_debut_snapshot_is_prior(T):
    L = league_rates(T, 2020)
    F, snaps, *_ = build_features(T, L, [("x", "7d4d7583df7eebf9", "Featherweight", "M", pd.Timestamp("2026-11-07"))])
    s = snaps["x"]           # Carlos Calderon, UFC debut
    assert s["n_fights"] == 0 and s["off_stand_l"] == pytest.approx(1.0) and s["debut"] == 1
