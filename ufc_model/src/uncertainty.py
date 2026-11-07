"""Parameter bootstrap (§19): draw rate factors from approximate posteriors and the win-model logit
from its Laplace posterior, re-solve the tilt, re-simulate, re-price. Gives per-key draws of p_model."""
from __future__ import annotations

import numpy as np

from .markets import price_bout
from .simulate import make_params, simulate, solve_tilt


def perturb_snapshot(s: dict | None, rng, debut_sigma=0.30) -> dict | None:
    if s is None:
        return None
    out = dict(s)
    for k, v in s.items():
        if k.startswith(("off_", "def_")):
            stat = k.split("_", 1)[1]
            effn = float(s.get(f"effn_{stat}", 0.0) or 0.0)
            sd = min(debut_sigma, 1.0 / np.sqrt(effn + 10.0))
            out[k] = float(v) * float(np.exp(sd * rng.standard_normal() - sd * sd / 2))
    return out


def boot_bout(args):
    """One bout's bootstrap. args = (sA, sB, L, wc, g, rounds, z_final_draws, G, n_tilt, n_sims, seed, sig_lines)."""
    sA, sB, L, wc, g, rounds, p_ml_draws, G, n_tilt, n_sims, seed, sig_lines = args
    rng = np.random.default_rng(seed)
    out = []
    for i, p_ml in enumerate(p_ml_draws):
        a = perturb_snapshot(sA, rng); b = perturb_snapshot(sB, rng)
        bp = make_params(a, b, L, wc, g, rounds, G)
        t, _ = solve_tilt(bp, float(p_ml), seed + i, n_tilt, G, tol=0.01)
        sim = simulate(bp, n_sims, seed + 7919 * (i + 1), t, G)
        out.append(price_bout(sim, sig_lines=sig_lines)["probs"])
    return out
