"""Fixed-seed regression: simulator outputs on a fixture bout stay stable (within tolerance) across code changes."""
import json
from pathlib import Path
import pytest
from src.simulate import Side, BoutParams, simulate, DEFAULT_GLOBALS
from src.markets import price_bout


def test_sim_regression():
    exp = json.loads((Path(__file__).parent / "fixtures/regression_sim.json").read_text())
    A = Side(stand_l=5.0, stand_a=12.0, ground_l=2.5, td_att=0.4, td_acc=0.35, ctrl_per_td=110, sub_rate=0.12, kd_per_head=0.012, share_head=0.6, share_body=0.2)
    B = Side(stand_l=4.2, stand_a=10.0, ground_l=2.0, td_att=0.6, td_acc=0.40, ctrl_per_td=120, sub_rate=0.10, kd_per_head=0.009, share_head=0.6, share_body=0.2)
    G = json.loads(json.dumps(DEFAULT_GLOBALS))
    bp = BoutParams(A=A, B=B, rounds=3, group="M_mid", gender="M", fatigue={1: 1.0, 2: 1.0, 3: 1.0})
    P = price_bout(simulate(bp, 20000, 123, 0.0, G))["probs"]
    for k, v in exp.items():
        assert P[k] == pytest.approx(v, abs=0.015), k


def test_tilt_monotone():
    from src.simulate import solve_tilt
    A = Side(5.0, 12.0, 2.5, 0.4, 0.35, 110, 0.12, 0.012, 0.6, 0.2)
    B = Side(4.2, 10.0, 2.0, 0.6, 0.40, 120, 0.10, 0.009, 0.6, 0.2)
    G = json.loads(json.dumps(DEFAULT_GLOBALS))
    bp = BoutParams(A=A, B=B, rounds=3, group="M_mid", gender="M")
    t, v = solve_tilt(bp, 0.30, 7, 4000, G, 0.005)
    assert abs(v - 0.30) < 0.01 and t < 0
