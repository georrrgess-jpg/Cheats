import numpy as np
import pytest
from src.markets import price_bout, prob_of
from src.checks import check_bout_markets


def fake_sim(n=2000, seed=0, rounds=3):
    rng = np.random.default_rng(seed)
    w = rng.choice([0, 1, 2], n, p=[0.55, 0.44, 0.01])
    m = np.where(w == 2, "DRAW", rng.choice(["KO", "SUB", "U-DEC", "S-DEC", "M-DEC"], n, p=[.3, .15, .4, .12, .03]))
    fin = np.isin(m, ["KO", "SUB"])
    t = np.where(fin, rng.uniform(0, rounds * 300, n), rounds * 300.0)
    sa = rng.poisson(40, n).astype(float); sb = rng.poisson(35, n).astype(float)
    return {"winner": w.astype(np.int8), "method": m, "end_t": t, "end_round": np.minimum((t // 300).astype(int) + 1, rounds),
            "sigA": sa, "sigB": sb, "tdA": rng.poisson(1, n).astype(float), "tdB": rng.poisson(1, n).astype(float),
            "kdA": rng.poisson(.2, n).astype(float), "kdB": rng.poisson(.2, n).astype(float),
            "ctrlA": np.zeros(n), "ctrlB": np.zeros(n), "rounds": rounds, "n": n}


def test_consistency_and_monotonic():
    pr = price_bout(fake_sim())
    P = pr["probs"]
    assert check_bout_markets(pr, P["ML|A"]) == []
    for k, v in P.items():
        assert 0 <= v <= 1 + 1e-12, k


def test_half_round_convention():
    # finish exactly at 2:30 of R2 (450 s): over 1.5 (boundary counts as over), under 2.5
    s = fake_sim(10)
    s["end_t"][:] = 450.0; s["method"][:] = "KO"; s["winner"][:] = 0
    P = price_bout(s)["probs"]
    assert P["ROUNDS_OU|OVER|1.5"] == 1.0
    assert P["ROUNDS_OU|OVER|2.5"] == 0.0
    s["end_t"][:] = 449.0
    assert price_bout(s)["probs"]["ROUNDS_OU|OVER|1.5"] == 0.0


def test_pushes_on_whole_lines():
    s = fake_sim(1000)
    s["sigA"][:] = 40.0
    pr = price_bout(s, sig_lines={"A": [40.0], "B": [35.5], "TOT": [75.5]})
    P = pr["probs"]
    w, push = prob_of(P, "SIG|A|OVER|40.0")
    assert w == 0 and push == 1.0
    assert prob_of(P, "SIG|A|UNDER|40.0")[0] == 0


def test_ml_draw_is_push():
    pr = price_bout(fake_sim())
    w, push = prob_of(pr["probs"], "ML|A")
    assert push == pytest.approx(pr["probs"]["DRAW|YES"])
    nw, _ = prob_of(pr["probs"], "NOT:METHOD|A:KO")
    assert nw == pytest.approx(1 - pr["probs"]["METHOD|A:KO"])


def test_grading_vectors():
    from src.markets import outcome_vector
    s = fake_sim(1)
    s["winner"][:] = 0; s["method"][:] = "DQ"; s["kdA"][:] = 0; s["kdB"][:] = 0; s["end_t"][:] = 400; s["end_round"][:] = 2
    s["sigA"][:] = 30; s["sigB"][:] = 20; s["tdA"][:] = 1; s["tdB"][:] = 1
    ov = lambda k: outcome_vector(s, k)[0]
    assert ov("METHOD|A:KO") == 1 and ov("METHOD|A:DEC") == 0 and ov("DIST|YES") == 0
    assert ov("KD|NO") == 1 and ov("KD|YES") == 0
    assert ov("MOST_SIG|A") == 1 and ov("MOST_TD|TIE") == 1
    assert ov("ROUND_GRP|A:R1-2") == 1 and ov("RD_METHOD|A:KO:R2") == 1 and ov("TIME_OU|UNDER|7.5") == 1
    assert ov("DEC_TYPE|A:U") == 0


def test_kelly_push():
    from src.staking import kelly_fraction
    assert kelly_fraction(0.5, 0.2, 2.2) == pytest.approx(0.3125)
