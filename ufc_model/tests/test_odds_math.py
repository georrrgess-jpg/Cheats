import math
import numpy as np
import pytest
from src.devig import (american_to_decimal, decimal_to_american, implied, prob_to_american, devig,
                       multiplicative, additive, power, shin, odds_ratio, one_sided_fair)
from src.staking import kelly_fraction, stake
from src.edge import shrink, ev_per_dollar
import pandas as pd


def test_conversions():
    assert american_to_decimal(+150) == pytest.approx(2.5)
    assert american_to_decimal(-200) == pytest.approx(1.5)
    assert decimal_to_american(2.5) == pytest.approx(150)
    assert decimal_to_american(1.5) == pytest.approx(-200)
    assert implied(-110) == pytest.approx(110 / 210)
    assert prob_to_american(0.5) == pytest.approx(100)
    assert prob_to_american(2 / 3) == pytest.approx(-200)
    with pytest.raises(ValueError):
        american_to_decimal(0)


def test_devig_hand_examples():
    q = [implied(-110), implied(-110)]
    for f in (multiplicative, additive, power, shin, odds_ratio):
        p = f(q)
        assert p.sum() == pytest.approx(1, abs=1e-9)
        assert p[0] == pytest.approx(0.5, abs=1e-9)
    # -200 / +170: multiplicative by hand
    q = [implied(-200), implied(170)]   # 0.6667, 0.3704 -> sum 1.0370
    p = multiplicative(q)
    assert p[0] == pytest.approx(0.6667 / 1.0370, abs=1e-3)
    pa = additive(q)
    assert pa[0] == pytest.approx(0.6667 - 0.0370 / 2, abs=1e-3)
    pp = power(q)
    assert pp.sum() == pytest.approx(1)
    assert pp[0] > p[0]          # power shifts margin toward the longshot
    ps = shin(q)
    assert ps.sum() == pytest.approx(1) and ps[0] > p[0]
    po = odds_ratio(q)
    assert po.sum() == pytest.approx(1)
    fair, hold = devig([-200, 170])
    assert hold == pytest.approx(0.0370, abs=1e-3)
    # 3-way shin
    f3, h3 = devig([-150, 200, 1200])
    assert f3.sum() == pytest.approx(1) and h3 > 0
    assert one_sided_fair(-110, 0.05) == pytest.approx(implied(-110) / 1.05)


def test_kelly_and_caps():
    assert kelly_fraction(0.55, 0, 2.0) == pytest.approx(0.10)
    assert kelly_fraction(0.40, 0, 2.0) == 0.0
    S = {"kelly_fraction": 0.25, "max_bet_frac": 0.02, "max_bout_frac": 0.03, "max_card_frac": 0.09,
         "bankroll_units": 100, "round_units": 0.1, "unit_dollars": None}
    bets = pd.DataFrame({"p_final_win": [0.6, 0.6, 0.6], "p_push": [0, 0, 0], "decimal": [2.0, 2.0, 2.0],
                         "bout_key": ["X", "X", "Y"]})
    out = stake(bets, S)
    assert (out.stake_frac <= 0.02 + 1e-12).all()
    assert out[out.bout_key == "X"].stake_frac.sum() <= 0.03 + 1e-12
    assert out.stake_units.tolist() == [1.5, 1.5, 2.0]


def test_ev_and_shrink():
    assert ev_per_dollar(0.5, 0, 2.2) == pytest.approx(0.1)
    assert ev_per_dollar(0.5, 0.1, 2.0) == pytest.approx(0.5 - 0.4)
    assert shrink(0.6, 0.5, 1.0) == pytest.approx(0.6)
    assert shrink(0.6, 0.5, 0.0) == pytest.approx(0.5)
    s = shrink(0.6, 0.5, 0.3)
    assert 0.5 < s < 0.6
    assert shrink(0.6, float("nan"), 0.3) == 0.6
