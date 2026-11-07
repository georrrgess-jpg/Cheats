"""Vectorized fight simulator (§14). T1 position model: standing / A-on-top / B-on-top, 30 s steps.

All sims advance together (numpy arrays over sims); there is no Python loop per sim. Per step:
strikes ~ Poisson(rate x form x pace x fatigue x tilt), head/body/leg split ~ multinomial (binomial
thinning), knockdowns ~ Binomial(head, kd_per_head x damage), takedown attempts/success, escapes and
reversals on the ground, then competing finish hazards (KO/TKO A/B, SUB A/B, doctor stoppage).
Decisions use a fight-level logistic judging model (§14.9 T1 fallback) with draw and split noise.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np

from .util import ROOT, cfg

GROUPS = {"Flyweight": "M_low", "Bantamweight": "M_low", "Featherweight": "M_low", "Lightweight": "M_mid",
          "Welterweight": "M_mid", "Middleweight": "M_mid", "Light Heavyweight": "M_high", "Heavyweight": "M_high",
          "Catchweight": "M_mid", "ALL": "M_mid"}


def group_of(wc: str, gender: str) -> str:
    return "F" if gender == "F" else GROUPS.get(wc, "M_mid")


DEFAULT_GLOBALS = {
    "q_kd": 0.30, "h_ns": 0.0035, "h_gnp": 0.0060, "q_sub": 0.22, "stand_sub_frac": 0.15,
    "escape_mult": 1.0, "reversal_p": 0.015, "bottom_strike_rate": 0.25, "ground_head_share": 0.80,
    "dmg_scale": 60.0, "dmg_round_decay": 0.75,
    "round_haz": [1.6, 1.0, 0.8, 0.8, 0.8],
    "strike_scale": {"M_low": 1.0, "M_mid": 1.0, "M_high": 1.0, "F": 1.0},
    "td_scale": {"M_low": 1.0, "M_mid": 1.0, "M_high": 1.0, "F": 1.0},
    "grapple_sigma": 0.6, "form_sigma": 0.28,
    "ko_scale": {"M_low": 1.0, "M_mid": 1.0, "M_high": 1.0, "F": 1.0},
    "sub_scale": {"M_low": 1.0, "M_mid": 1.0, "M_high": 1.0, "F": 1.0},
    # judging model: z = b . [sig diff, kd diff, td diff, ctrl diff (min), ground diff]; P(unanimous|z), P(draw|z)
    "judge_beta": [0.045, 0.9, 0.35, 0.18, 0.0], "unan_a": 0.2, "unan_b": 0.9, "draw_a": -3.6, "draw_b": -1.5,
    "majority_frac": 0.11,
}


def load_globals() -> dict:
    path = ROOT / "data/processed/sim_globals.json"
    g = json.loads(json.dumps(DEFAULT_GLOBALS))
    if path.exists():
        g.update(json.loads(path.read_text()))
    return g


@dataclass
class Side:
    stand_l: float; stand_a: float; ground_l: float; td_att: float; td_acc: float; ctrl_per_td: float
    sub_rate: float; kd_per_head: float; share_head: float; share_body: float; cardio: float = 1.0


@dataclass
class BoutParams:
    A: Side; B: Side; rounds: int; group: str; gender: str; fatigue: dict = field(default_factory=dict)
    ko_mA: float = 1.0; ko_mB: float = 1.0; sub_mA: float = 1.0; sub_mB: float = 1.0


def side_params(sx: dict, sy: dict, L: dict) -> Side:
    """Fighter X attacking fighter Y. sx/sy are feature snapshots (factors), L league rates for the division."""
    g = lambda d, k: float(d.get(k, 1.0)) if d is not None else 1.0
    return Side(
        stand_l=L["stand_l"] * g(sx, "off_stand_l") * g(sy, "def_stand_l"),
        stand_a=L["stand_a"] * g(sx, "off_stand_a") * g(sy, "def_stand_a"),
        ground_l=L["ground_l"] * g(sx, "off_ground_l") * g(sy, "def_ground_l"),
        td_att=L["td_a"] * g(sx, "off_td_a") * g(sy, "def_td_a"),
        td_acc=float(np.clip(L["td_l"] * g(sx, "off_td_l") * g(sy, "def_td_l"), 0.03, 0.85)),
        ctrl_per_td=float(np.clip(L["ctrl"] * g(sx, "off_ctrl") * g(sy, "def_ctrl"), 25, 400)),
        sub_rate=L["sub_att"] * g(sx, "off_sub_att") * g(sy, "def_sub_att"),
        kd_per_head=L["kd"] * g(sx, "off_kd") * g(sy, "def_kd"),
        share_head=float((sx or {}).get("share_head", L["share_head"])),
        share_body=float((sx or {}).get("share_body", L["share_body"])),
        cardio=float((sx or {}).get("cardio", 1.0)),
    )


def simulate(bp: BoutParams, n: int, seed: int, tilt: float = 0.0, G: dict | None = None,
             form_sigma: float | None = None, pace_sigma: float | None = None) -> dict:
    C = cfg()
    G = G or load_globals()
    rng = np.random.default_rng(seed)
    fs = G.get("form_sigma", C["sim"]["form_sigma"]) if form_sigma is None else form_sigma
    gs = G.get("grapple_sigma", 0.6)
    tds = G.get("td_scale", {}).get(bp.group, 1.0)
    ps = C["sim"]["pace_sigma"] if pace_sigma is None else pace_sigma
    step = C["sim"]["step_s"]
    dt_min = step / 60.0
    steps_per_round = 300 // step
    ko_s = G["ko_scale"][bp.group]; sub_s = G["sub_scale"][bp.group]
    A, B = bp.A, bp.B
    ss = G["strike_scale"][bp.group]
    tA, tB = np.exp(tilt), np.exp(-tilt)
    formA = np.exp(fs * rng.standard_normal(n) - fs * fs / 2)
    formB = np.exp(fs * rng.standard_normal(n) - fs * fs / 2)
    pace = np.exp(ps * rng.standard_normal(n) - ps * ps / 2)
    gA = np.exp(gs * rng.standard_normal(n) - gs * gs / 2) * tds   # night-to-night grappling intent/form
    gB = np.exp(gs * rng.standard_normal(n) - gs * gs / 2) * tds
    pos = np.zeros(n, np.int8)                        # 0 standing, 1 A top, 2 B top
    alive = np.ones(n, bool)
    z = lambda: np.zeros(n)
    sigA, sigB, headA, headB, bodyA, bodyB = z(), z(), z(), z(), z(), z()
    attA, attB = z(), z()
    tdA, tdB, tdaA, tdaB, kdA, kdB, ctrlA, ctrlB, subA, subB, grA, grB = (z() for _ in range(12))
    dmgA, dmgB = z(), z()                             # damage absorbed by A / by B
    kd_recentA, kd_recentB = np.zeros(n, bool), np.zeros(n, bool)
    method = np.full(n, "", dtype=object)             # KO / SUB / DOC filled on finish
    winner = np.full(n, -1, np.int8)                  # 0 A, 1 B, 2 draw
    end_t = np.full(n, bp.rounds * 300.0)
    fat = bp.fatigue or {}
    for r in range(1, bp.rounds + 1):
        fr = fat.get(r, 1.0) * ss
        rh = G["round_haz"][min(r, len(G["round_haz"])) - 1] * (G.get("five_rd_haz", 1.0) if bp.rounds == 5 else 1.0)
        q_kd = min(G["q_kd"] * ko_s * rh, 0.9)
        cA = A.cardio ** ((r - 1) / 2.0); cB = B.cardio ** ((r - 1) / 2.0)
        if r > 1:
            dmgA *= G["dmg_round_decay"]; dmgB *= G["dmg_round_decay"]
            pos[:] = 0                                # round starts standing
        for s in range(steps_per_round):
            t0 = (r - 1) * 300 + s * step
            idx = np.nonzero(alive)[0]
            if idx.size == 0:
                break
            p_ = pos[idx]
            st = p_ == 0; at = p_ == 1; bt = p_ == 2
            mA = formA[idx] * pace[idx] * fr * cA * tA
            mB = formB[idx] * pace[idx] * fr * cB * tB
            # ---- striking
            lamA = np.where(st, A.stand_l, np.where(at, A.ground_l, A.ground_l * G["bottom_strike_rate"])) * mA * dt_min
            lamB = np.where(st, B.stand_l, np.where(bt, B.ground_l, B.ground_l * G["bottom_strike_rate"])) * mB * dt_min
            nA = rng.poisson(lamA); nB = rng.poisson(lamB)
            hsA = np.where(st, A.share_head, G["ground_head_share"]); hsB = np.where(st, B.share_head, G["ground_head_share"])
            hA = rng.binomial(nA, hsA); hB = rng.binomial(nB, hsB)
            bA = rng.binomial(nA - hA, np.clip(A.share_body / max(1 - A.share_head, 1e-6), 0, 1))
            bB = rng.binomial(nB - hB, np.clip(B.share_body / max(1 - B.share_head, 1e-6), 0, 1))
            # attempts (accuracy props): landed / accuracy, standing only accuracy differs
            accA = min(A.stand_l / max(A.stand_a, 1e-6), 0.9); accB = min(B.stand_l / max(B.stand_a, 1e-6), 0.9)
            aA = nA + rng.poisson(np.where(st, nA * (1 / accA - 1), nA * 0.4))
            aB = nB + rng.poisson(np.where(st, nB * (1 / accB - 1), nB * 0.4))
            # ---- knockdowns (standing head strikes only)
            pkA = np.clip(A.kd_per_head * tA * np.sqrt(formA[idx]) * (1 + dmgB[idx] / G["dmg_scale"]), 0, 0.5)
            pkB = np.clip(B.kd_per_head * tB * np.sqrt(formB[idx]) * (1 + dmgA[idx] / G["dmg_scale"]), 0, 0.5)
            kA = np.where(st, rng.binomial(hA, pkA), 0); kB = np.where(st, rng.binomial(hB, pkB), 0)
            # ---- takedowns (standing)
            tdaA_ = np.where(st, rng.poisson(A.td_att * gA[idx] * np.sqrt(tA) * dt_min), 0)
            tdaB_ = np.where(st, rng.poisson(B.td_att * gB[idx] * np.sqrt(tB) * dt_min), 0)
            tdA_ = rng.binomial(tdaA_, np.clip(A.td_acc * tA, 0.01, 0.95))
            tdB_ = rng.binomial(tdaB_, np.clip(B.td_acc * tB, 0.01, 0.95))
            # ---- submissions (attempts)
            sA_ = rng.poisson(A.sub_rate * tA * dt_min * np.where(at, 1.0, np.where(st, G["stand_sub_frac"], 0.15)))
            sB_ = rng.poisson(B.sub_rate * tB * dt_min * np.where(bt, 1.0, np.where(st, G["stand_sub_frac"], 0.15)))
            # ---- accumulate
            sigA[idx] += nA; sigB[idx] += nB; headA[idx] += hA; headB[idx] += hB; bodyA[idx] += bA; bodyB[idx] += bB
            attA[idx] += aA; attB[idx] += aB
            grA[idx] += np.where(at, nA, 0); grB[idx] += np.where(bt, nB, 0)
            kdA[idx] += kA; kdB[idx] += kB; tdA[idx] += tdA_; tdB[idx] += tdB_; tdaA[idx] += tdaA_; tdaB[idx] += tdaB_
            subA[idx] += sA_; subB[idx] += sB_
            ctrlA[idx] += np.where(at, step, 0); ctrlB[idx] += np.where(bt, step, 0)
            dmgB[idx] += hA + 4 * kA; dmgA[idx] += hB + 4 * kB
            # ---- finish hazards
            dB = 1 + dmgB[idx] / G["dmg_scale"]; dA = 1 + dmgA[idx] / G["dmg_scale"]
            lnsA = G["h_ns"] * ko_s * rh * hA * np.where(st, 1.0, 0.0) * dB * np.where(kd_recentB[idx], 2.5, 1.0) \
                + G["h_gnp"] * ko_s * rh * np.where(at, nA, 0) * dB
            lnsB = G["h_ns"] * ko_s * rh * hB * np.where(st, 1.0, 0.0) * dA * np.where(kd_recentA[idx], 2.5, 1.0) \
                + G["h_gnp"] * ko_s * rh * np.where(bt, nB, 0) * dA
            pKA = 1 - (1 - min(q_kd * bp.ko_mA, 0.9)) ** kA * np.exp(-lnsA * bp.ko_mA * np.sqrt(formA[idx]))
            pKB = 1 - (1 - min(q_kd * bp.ko_mB, 0.9)) ** kB * np.exp(-lnsB * bp.ko_mB * np.sqrt(formB[idx]))
            qs = G["q_sub"] * sub_s * rh
            pSA = 1 - (1 - min(qs * bp.sub_mA, 0.9)) ** sA_
            pSB = 1 - (1 - min(qs * bp.sub_mB, 0.9)) ** sB_
            pD = np.clip(C["sim"]["doctor_stoppage_base"] * (dmgA[idx] + dmgB[idx]) / G["dmg_scale"], 0, 0.01)
            u = rng.random(idx.size)
            c1 = pKA; c2 = c1 + pKB; c3 = c2 + pSA; c4 = c3 + pSB; c5 = c4 + pD
            tot = np.maximum(c5, 1.0)                 # renormalize if hazards sum > 1
            u = u * tot
            fin = u < c5
            if fin.any():
                fi = idx[fin]; uu = u[fin]
                m_ = np.select([uu < c1[fin], uu < c2[fin], uu < c3[fin], uu < c4[fin]], ["KO", "KO", "SUB", "SUB"], "DOC")
                w_ = np.select([uu < c1[fin], uu < c2[fin], uu < c3[fin], uu < c4[fin]], [0, 1, 0, 1],
                               -9).astype(np.int8)
                # doctor stoppage goes against the more damaged fighter
                doc = w_ == -9
                w_[doc] = np.where(dmgA[fi[doc]] > dmgB[fi[doc]], 1, 0)
                method[fi] = m_; winner[fi] = w_
                end_t[fi] = t0 + rng.uniform(0, step, fi.size)
                alive[fi] = False
            kd_recentA[idx] = kB > 0; kd_recentB[idx] = kA > 0
            # ---- position transitions for survivors
            still = alive[idx]
            newpos = p_.copy()
            gotA = st & (tdA_ > 0); gotB = st & (tdB_ > 0)
            both = gotA & gotB
            coin = rng.random(idx.size) < 0.5
            newpos[gotA & ~(both & coin)] = 1
            newpos[gotB & ~(both & ~coin)] = 2
            escA = at & (rng.random(idx.size) < 1 - np.exp(-step / (A.ctrl_per_td / G["escape_mult"])))
            escB = bt & (rng.random(idx.size) < 1 - np.exp(-step / (B.ctrl_per_td / G["escape_mult"])))
            newpos[escA | escB] = 0
            rev = (at | bt) & ~(escA | escB) & (rng.random(idx.size) < G["reversal_p"])
            newpos[rev & at] = 2; newpos[rev & bt] = 1
            pos[idx[still]] = newpos[still]
    # ---- decisions
    dec = alive
    if dec.any():
        b = np.array(G["judge_beta"])
        Xd = np.stack([sigA - sigB, kdA - kdB, tdA - tdB, (ctrlA - ctrlB) / 60.0, grA - grB], axis=1)[dec]
        zz = Xd @ b + rng.normal(0, 0.35, dec.sum())          # judging noise
        pdraw = 1 / (1 + np.exp(-(G["draw_a"] + G["draw_b"] * np.abs(zz))))
        u = rng.random(dec.sum())
        is_draw = u < pdraw
        pa = 1 / (1 + np.exp(-zz))
        wa = rng.random(dec.sum()) < pa
        w = np.where(is_draw, 2, np.where(wa, 0, 1)).astype(np.int8)
        punan = 1 / (1 + np.exp(-(G["unan_a"] + G["unan_b"] * np.abs(zz))))
        un = rng.random(dec.sum()) < punan
        maj = rng.random(dec.sum()) < G["majority_frac"]
        m = np.where(is_draw, "DRAW", np.where(un, "U-DEC", np.where(maj, "M-DEC", "S-DEC")))
        winner[dec] = w; method[dec] = m
    end_round = np.minimum((end_t // 300).astype(int) + 1, bp.rounds)
    return {"winner": winner, "method": method.astype(str), "end_t": end_t, "end_round": end_round,
            "sigA": sigA, "sigB": sigB, "headA": headA, "headB": headB, "bodyA": bodyA, "bodyB": bodyB,
            "legA": sigA - headA - bodyA, "legB": sigB - headB - bodyB, "attA": attA, "attB": attB,
            "tdA": tdA, "tdB": tdB, "tdaA": tdaA, "tdaB": tdaB, "kdA": kdA, "kdB": kdB, "ctrlA": ctrlA,
            "ctrlB": ctrlB, "subA": subA, "subB": subB, "rounds": bp.rounds, "n": n}


def p_win_a(sim) -> float:
    """P(A wins) on the moneyline scale used for the tilt: draws excluded from both sides."""
    return float(np.mean(sim["winner"] == 0))


def solve_tilt(bp: BoutParams, target_pa: float, seed: int, n: int, G=None, tol=0.005, lo=-2.0, hi=2.0):
    """Bisection on scalar tilt t so P(A wins | no draw) == target (common random numbers)."""
    def f(t):
        s = simulate(bp, n, seed, t, G)
        w = s["winner"]
        nd = np.mean(w != 2)
        return np.mean(w == 0) / max(nd, 1e-9)
    flo, fhi = f(lo), f(hi)
    if target_pa <= flo:
        return lo, flo
    if target_pa >= fhi:
        return hi, fhi
    t = 0.5 * (lo + hi)
    v = f(t)
    for _ in range(14):
        if abs(v - target_pa) < tol / 2:
            break
        if v < target_pa:
            lo = t
        else:
            hi = t
        t = 0.5 * (lo + hi)
        v = f(t)
    return t, v


def finish_mults(sx: dict | None, sy: dict | None, gender: str, G: dict) -> tuple[float, float]:
    """Fighter-specific finish propensity (X attacking Y): shrunk per-fight KO/SUB win rate of X times
    shrunk KO/SUB loss rate of Y, relative to league, raised to a calibrated alpha (0 = off)."""
    a = G.get("finish_alpha", 0.0)
    if a == 0 or sx is None or sy is None:
        return 1.0, 1.0
    mu = G.get("mu_fin", {}).get(gender, {"ko": 0.165, "sub": 0.09})
    k = G.get("finish_prior_fights", 3.0)
    rate = lambda c, n, m: (c + k * m) / (n + k) / m
    nx, ny = sx.get("n_fights", 0), sy.get("n_fights", 0)
    ko = rate(sx.get("ko_wins", 0), nx, mu["ko"]) * rate(sy.get("ko_losses", 0), ny, mu["ko"])
    sb = rate(sx.get("sub_wins", 0), nx, mu["sub"]) * rate(sy.get("sub_losses", 0), ny, mu["sub"])
    return float(np.clip(ko ** a, 0.25, 4.0)), float(np.clip(sb ** a, 0.25, 4.0))


def make_params(sA: dict, sB: dict, L_all: dict, wc: str, gender: str, rounds: int, G: dict | None = None) -> BoutParams:
    key = (wc, gender) if (wc, gender) in L_all else ("ALL", gender)
    L = L_all[key]
    fat = dict(L_all["fatigue"].get((gender, int(rounds)), {}))
    if fat:
        mean = np.mean([fat.get(r, 1.0) for r in range(1, int(rounds) + 1)])
        fat = {r: v / mean for r, v in fat.items()}
    G = G or load_globals()
    kA, sA_ = finish_mults(sA, sB, gender, G)
    kB, sB_ = finish_mults(sB, sA, gender, G)
    return BoutParams(A=side_params(sA, sB, L), B=side_params(sB, sA, L), rounds=int(rounds),
                      group=group_of(wc, gender), gender=gender, fatigue=fat, ko_mA=kA, ko_mB=kB, sub_mA=sA_, sub_mB=sB_)
