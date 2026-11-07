"""Point-in-time features (§11). One chronological pass: for every fight we FIRST snapshot both
fighters' state (built only from earlier fights) and THEN update the state with the fight. This makes
leakage impossible by construction (tested in tests/test_leakage.py).

Opponent adjustment (§11.2) is multiplicative/Poisson-style: for stat s, fighter f's offense factor is
    off_f = (Σ_decay landed + k) / (Σ_decay expected + k),
    expected = league_rate[s, wc, gender] × exposure × defense_factor_of_opponent (as of that fight),
which is the one-step (online) solution of log(rate) = μ + offense[attacker] + defense[defender] with an
exposure offset, shrunk toward the weight-class prior by k pseudo-units (empirical Bayes, §11.3).
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict

import numpy as np
import pandas as pd

from .ratings import Elo
from .util import cfg

log = logging.getLogger("ufc.features")

# (stat, exposure kind). Exposure: 'stand' = standing minutes, 'top' = own control minutes,
# 'all' = total minutes, 'tda' = own TD attempts, 'head' = own head sig landed, 'tdl' = own TD landed,
# 'sub' = top minutes + 0.15 * standing minutes.
RATE_STATS = [
    ("stand_l", "stand"), ("stand_a", "stand"), ("ground_l", "top"), ("sig_l", "all"), ("sig_a", "all"),
    ("head_l", "all"), ("td_a", "stand"), ("td_l", "tda"), ("ctrl", "tdl"), ("sub_att", "sub"),
    ("kd", "head"), ("total_l", "all"),
]
STAT_NAMES = [s for s, _ in RATE_STATS]


def _obs(ff_row, opp_row, minutes):
    """Per-fight observation for one fighter (offense) given own and opponent totals."""
    g = lambda r, k: float(r.get(k, 0.0) or 0.0) if r is not None else 0.0
    ctrl_a, ctrl_b = g(ff_row, "ctrl_s"), g(opp_row, "ctrl_s")
    m = max(minutes, 1e-6)
    ground_min = min((ctrl_a + ctrl_b) / 60.0, 0.95 * m)
    stand_min = max(m - ground_min, 0.05 * m)
    top_min = ctrl_a / 60.0
    x = {
        "stand_l": g(ff_row, "dist_l") + g(ff_row, "clinch_l"),
        "stand_a": g(ff_row, "dist_a") + g(ff_row, "clinch_a"),
        "ground_l": g(ff_row, "ground_l"), "sig_l": g(ff_row, "sig_l"), "sig_a": g(ff_row, "sig_a"),
        "head_l": g(ff_row, "head_l"), "td_a": g(ff_row, "td_a"), "td_l": g(ff_row, "td_l"),
        "ctrl": ctrl_a, "sub_att": g(ff_row, "sub_att"), "kd": g(ff_row, "kd"), "total_l": g(ff_row, "total_l"),
        "body_l": g(ff_row, "body_l"), "leg_l": g(ff_row, "leg_l"),
    }
    expo = {"stand": stand_min, "top": top_min, "all": m, "tda": x["td_a"], "head": x["head_l"],
            "tdl": x["td_l"], "sub": top_min + 0.15 * stand_min}
    return x, expo


def league_rates(tables, min_year=2010) -> dict:
    """League rate for each stat per unit exposure, by (weight_class, gender); plus fatigue & shares."""
    fights = tables["fights"]
    ff = tables["fighter_fight"]
    f = fights[(fights.date.dt.year >= min_year) & fights.std_format & fights.end_time_s.notna()]
    ff = ff.merge(f[["fight_id", "weight_class", "gender", "end_time_s"]], on="fight_id")
    opp = ff.rename(columns={c: "o_" + c for c in ff.columns if c not in ("fight_id",)})
    ff = ff.merge(opp, left_on=["fight_id", "opponent_id"], right_on=["fight_id", "o_fighter_id"])
    rows = []
    for r in ff.to_dict("records"):
        x, e = _obs(r, {k[2:]: v for k, v in r.items() if k.startswith("o_")}, r["end_time_s"] / 60.0)
        rows.append({"wc": r["weight_class"], "g": r["gender"], **{f"x_{k}": v for k, v in x.items()},
                     **{f"e_{s}": e[k] for s, k in RATE_STATS}})
    df = pd.DataFrame(rows)
    out = {}
    for (wc, g), d in list(df.groupby(["wc", "g"])) + [(("ALL", "M"), df[df.g == "M"]), (("ALL", "F"), df[df.g == "F"])]:
        rates = {s: d[f"x_{s}"].sum() / max(d[f"e_{s}"].sum(), 1e-9) for s in STAT_NAMES}
        tot = d["x_sig_l"].sum()
        rates["share_head"] = d["x_head_l"].sum() / tot
        rates["share_body"] = d["x_body_l"].sum() / tot
        rates["share_leg"] = d["x_leg_l"].sum() / tot
        rates["n"] = len(d)
        out[(wc, g)] = rates
    # fatigue: league sig strikes landed per minute by round, relative to round 1 (std-format, full rounds)
    fr = tables["fight_rounds"].merge(f[["fight_id", "weight_class", "gender", "scheduled_rounds"]], on="fight_id")
    fr = fr[fr.round_time_s >= 60]
    fat = {}
    for (g, sr), d in fr.groupby(["gender", "scheduled_rounds"]):
        rate = d.groupby("round").apply(lambda z: z.sig_l.sum() / (z.round_time_s.sum() / 60.0), include_groups=False)
        fat[(g, int(sr))] = (rate / rate.loc[1]).to_dict()
    out["fatigue"] = fat
    return out


def _lr(L, wc, g, s):
    return L.get((wc, g), L[("ALL", g)]).get(s, L[("ALL", g)][s])


class FighterState:
    __slots__ = ("last", "on", "oe", "dn", "de", "minutes", "n", "wins", "losses", "ko_losses",
                 "sub_losses", "dec_losses", "ko_wins", "sub_wins", "dec_wins", "head_abs_career",
                 "dates", "streak", "r1", "r3", "r45_rounds", "share", "share_tot", "td_def_n", "td_def_d",
                 "tdl_abs", "ctrl_abs", "last_result", "five_rd_fights", "sh_n", "draws", "nc")

    def __init__(self):
        self.last = None
        self.on = defaultdict(float); self.oe = defaultdict(float)
        self.dn = defaultdict(float); self.de = defaultdict(float)
        self.minutes = 0.0; self.n = 0; self.wins = 0; self.losses = 0; self.draws = 0; self.nc = 0
        self.ko_losses = []; self.sub_losses = 0; self.dec_losses = 0
        self.ko_wins = 0; self.sub_wins = 0; self.dec_wins = 0
        self.head_abs_career = 0.0; self.dates = []; self.streak = 0
        self.r1 = [0.0, 0.0]; self.r3 = [0.0, 0.0]; self.r45_rounds = 0
        self.share = defaultdict(float); self.share_tot = 0.0
        self.last_result = None; self.five_rd_fights = 0; self.sh_n = 0

    def decay(self, date, hl):
        if self.last is None:
            self.last = date
            return
        dd = (date - self.last).days
        if dd <= 0:
            return
        f = 0.5 ** (dd / hl)
        for dct in (self.on, self.oe, self.dn, self.de, self.share):
            for k in dct:
                dct[k] *= f
        self.share_tot *= f
        self.r1 = [v * f for v in self.r1]
        self.r3 = [v * f for v in self.r3]
        self.last = date


def factors(st: FighterState, date, L, wc, g, C) -> dict:
    """Pre-fight shrunk factors for a fighter as of `date` (state must contain only earlier fights)."""
    hl = C["features"]["half_life_days"]
    if st.last is not None and date is not None:
        dd = max((date - st.last).days, 0)
        f = 0.5 ** (dd / hl)
    else:
        f = 1.0
    pm, pa, ph, ps = (C["features"][k] for k in ("prior_minutes", "prior_attempts_td", "prior_head_kd", "prior_sub"))
    out = {}
    for s, ek in RATE_STATS:
        rate = _lr(L, wc, g, s)
        if ek in ("stand", "top", "all"):
            k = pm * rate * (0.5 if ek == "top" else 1.0)
        elif ek == "tda":
            k = pa * rate
        elif ek == "head":
            k = ph * rate
        elif ek == "tdl":
            k = 3.0 * rate
        else:
            k = ps
        k = max(k, 1e-6)
        out[f"off_{s}"] = (st.on[s] * f + k) / (st.oe[s] * f + k)
        out[f"def_{s}"] = (st.dn[s] * f + k) / (st.de[s] * f + k)
        out[f"effn_{s}"] = st.oe[s] * f
    for t in ("head", "body", "leg"):
        prior = _lr(L, wc, g, f"share_{t}")
        out[f"share_{t}"] = (st.share[t] * f + 40 * prior) / (st.share_tot * f + 40)
    lr31 = L["fatigue"].get((g, 3), {}).get(3, 0.9)
    out["cardio"] = (st.r3[0] * f + 30 * lr31) / (st.r1[0] * f * 1.0 + 30) / lr31 if st.r1[0] > 0 else 1.0
    out["cardio"] = float(np.clip(out["cardio"], 0.6, 1.5))
    return out


def build_features(tables, L=None, extra_snapshots: list[tuple[str, str, str, str, pd.Timestamp]] | None = None):
    """Returns (fight_feats DataFrame [one row per fight x fighter, pre-fight], snapshots for
    `extra_snapshots` = [(key, fighter_id, wc, gender, date)], elo object, final states)."""
    C = cfg()
    hl = C["features"]["half_life_days"]
    L = L or league_rates(tables, C["data"]["league_min_year"])
    fights = tables["fights"].sort_values(["date", "fight_id"]).reset_index(drop=True)
    ffd = {(r["fight_id"], r["fighter_id"]): r for r in tables["fighter_fight"].to_dict("records")}
    fr = tables["fight_rounds"]
    r13 = fr[fr["round"].isin([1, 3])].groupby(["fight_id", "fighter_id", "round"]).agg(
        sig=("sig_l", "sum"), t=("round_time_s", "max")).reset_index()
    rnd = {(a, b, c): (d, e) for a, b, c, d, e in r13.itertuples(index=False)}
    fighters = tables["fighters"].set_index("fighter_id")
    dob = fighters["dob"].to_dict(); height = fighters["height_in"].to_dict(); reach = fighters["reach_in"].to_dict()
    stance = fighters["stance"].to_dict()
    e = C["elo"]
    elo = Elo(e["k"], e["init"], e["scale"], e["debut_penalty"], e["finish_boost"])
    S: dict[str, FighterState] = defaultdict(FighterState)
    rows = []

    def snap(fid, oid, date, wc, g):
        st = S[fid]
        fx = factors(st, date, L, wc, g, C)
        age = (date - dob[fid]).days / 365.25 if fid in dob and pd.notna(dob.get(fid)) else np.nan
        ko3 = sum(1 for d in st.ko_losses if (date - d).days <= 3 * 365)
        last12 = sum(1 for d in st.dates if (date - d).days <= 365)
        layoff = (date - st.dates[-1]).days if st.dates else np.nan
        return {
            "fighter_id": fid, "elo": elo.get(fid), "elo_rd": elo.rd(fid), "n_fights": st.n,
            "ufc_minutes": st.minutes, "wins": st.wins, "losses": st.losses,
            "win_rate_shr": (st.wins + 2) / (st.n + 4), "ko_losses": len(st.ko_losses), "ko_losses_3y": ko3,
            "last_ko_loss_days": (date - st.ko_losses[-1]).days if st.ko_losses else np.nan,
            "sub_losses": st.sub_losses, "ko_wins": st.ko_wins, "sub_wins": st.sub_wins, "dec_wins": st.dec_wins,
            "finish_rate": (st.ko_wins + st.sub_wins + 0.5) / (st.wins + 1.5),
            "finished_rate": (len(st.ko_losses) + st.sub_losses + 0.5) / (st.losses + 1.5),
            "head_abs_career": st.head_abs_career, "fights_12m": last12, "layoff_days": layoff,
            "streak": st.streak, "r45_rounds": st.r45_rounds, "five_rd_fights": st.five_rd_fights,
            "age": age, "height": height.get(fid, np.nan), "reach": reach.get(fid, np.nan),
            "stance": stance.get(fid), "debut": int(st.n == 0), **fx,
        }

    for fr_ in fights.itertuples(index=False):
        a, b, date = fr_.fighter_a_id, fr_.fighter_b_id, fr_.date
        if not isinstance(a, str) or not isinstance(b, str) or pd.isna(date):
            continue
        wc, g = fr_.weight_class, fr_.gender
        if wc == "Catchweight":
            wc = "ALL"
        S[a].decay(date, hl); S[b].decay(date, hl)
        sa, sb = snap(a, b, date, wc, g), snap(b, a, date, wc, g)
        rows.append({"fight_id": fr_.fight_id, "date": date, "side": "A", "opponent_id": b, **sa})
        rows.append({"fight_id": fr_.fight_id, "date": date, "side": "B", "opponent_id": a, **sb})
        # ---- update state with this fight (after snapshot) ----
        m = (fr_.end_time_s / 60.0) if pd.notna(fr_.end_time_s) else np.nan
        ra, rb = ffd.get((fr_.fight_id, a)), ffd.get((fr_.fight_id, b))
        use_rates = (date.year >= C["data"]["rates_min_year"]) and np.isfinite(m) and ra is not None and rb is not None \
            and fr_.std_format
        if use_rates:
            xa, ea = _obs(ra, rb, m)
            xb, eb = _obs(rb, ra, m)
            fa = factors(S[a], date, L, wc, g, C)
            fb = factors(S[b], date, L, wc, g, C)
            for s, ek in RATE_STATS:
                rate = _lr(L, wc, g, s)
                S[a].on[s] += xa[s]; S[a].oe[s] += rate * ea[ek] * fb[f"def_{s}"]
                S[a].dn[s] += xb[s]; S[a].de[s] += rate * eb[ek] * fb[f"off_{s}"]
                S[b].on[s] += xb[s]; S[b].oe[s] += rate * eb[ek] * fa[f"def_{s}"]
                S[b].dn[s] += xa[s]; S[b].de[s] += rate * ea[ek] * fa[f"off_{s}"]
            for fid, x in ((a, xa), (b, xb)):
                for t in ("head", "body", "leg"):
                    S[fid].share[t] += x[f"{t}_l"]
                S[fid].share_tot += x["sig_l"]
            S[a].head_abs_career += xb["head_l"]; S[b].head_abs_career += xa["head_l"]
            for fid in (a, b):
                v1, v3 = rnd.get((fr_.fight_id, fid, 1)), rnd.get((fr_.fight_id, fid, 3))
                if v1 and v3 and v1[1] >= 240 and v3[1] >= 120:
                    S[fid].r1[0] += v1[0] / (v1[1] / 60) * 1.0
                    S[fid].r3[0] += v3[0] / (v3[1] / 60) * 1.0
        for fid in (a, b):
            st = S[fid]
            st.n += 1
            st.dates.append(date)
            if np.isfinite(m):
                st.minutes += m
                if fr_.scheduled_rounds == 5:
                    st.five_rd_fights += 1
                    st.r45_rounds += max(0, int(fr_.end_round or 0) - 3)
        if fr_.result_type == "WIN" and isinstance(fr_.winner_id, str):
            w = fr_.winner_id
            l = b if w == a else a
            S[w].wins += 1; S[l].losses += 1
            S[w].streak = S[w].streak + 1 if S[w].streak >= 0 else 1
            S[l].streak = S[l].streak - 1 if S[l].streak <= 0 else -1
            mth = fr_.method
            if mth in ("KO", "DOC"):
                S[w].ko_wins += 1; S[l].ko_losses.append(date)
            elif mth == "SUB":
                S[w].sub_wins += 1; S[l].sub_losses += 1
            elif mth in ("U-DEC", "S-DEC", "M-DEC"):
                S[w].dec_wins += 1; S[l].dec_losses += 1
            elo.update(a, b, 1.0 if w == a else 0.0, finish=mth in ("KO", "SUB"))
        elif fr_.result_type == "DRAW":
            S[a].draws += 1; S[b].draws += 1
            elo.update(a, b, 0.5)
        else:
            S[a].nc += 1; S[b].nc += 1

    feats = pd.DataFrame(rows)
    snaps = {}
    for key, fid, wc, g, date in (extra_snapshots or []):
        if fid is None:
            snaps[key] = None
            continue
        st = S[fid]
        tmp_last = st.last
        snaps[key] = snap(fid, None, date, wc, g)
        st.last = tmp_last
    return feats, snaps, elo, S, L


# ---------------------------------------------------------------- model matrix (feature differences)
DIFF_FEATS = ["elo", "off_stand_l", "def_stand_l", "off_td_a", "off_td_l", "def_td_l", "off_ctrl", "def_ctrl",
              "off_sub_att", "def_sub_att", "off_kd", "def_kd", "off_ground_l", "win_rate_shr", "ko_losses_3y",
              "finish_rate", "finished_rate", "log_n", "log_min", "age", "age2", "reach", "height", "log_layoff",
              "streak", "fights_12m", "cardio", "acc_stand", "debut"]


def add_derived(d: pd.DataFrame) -> pd.DataFrame:
    d = d.copy()
    for c in [c for c in d.columns if c.startswith(("off_", "def_"))]:
        d[c] = np.log(np.clip(d[c].astype(float), 1e-3, None))
    d["acc_stand"] = d["off_stand_l"] - d["off_stand_a"]
    d["log_n"] = np.log1p(d["n_fights"])
    d["log_min"] = np.log1p(d["ufc_minutes"])
    d["age2"] = (d["age"] - 30) ** 2
    d["log_layoff"] = np.log1p(d["layoff_days"].fillna(365))
    d["streak"] = d["streak"].clip(-4, 6)
    return d


def pair_matrix(fa: pd.DataFrame, fb: pd.DataFrame, ctx: pd.DataFrame | None = None) -> pd.DataFrame:
    """Rows aligned: fa[i] (fighter A) vs fb[i]. Returns difference features + matchup interactions."""
    A, B = add_derived(fa.reset_index(drop=True)), add_derived(fb.reset_index(drop=True))
    X = pd.DataFrame(index=A.index)
    for c in DIFF_FEATS:
        if c in ("age", "age2", "reach", "height"):
            ok = A[c].notna() & B[c].notna()
            X[c] = np.where(ok, A[c] - B[c], 0.0)
            if c in ("age", "reach"):
                X[f"{c}_missing"] = (~ok).astype(float)
        else:
            X[c] = (A[c].fillna(0) - B[c].fillna(0)).astype(float)
    X["elo"] = X["elo"] / 100.0
    # matchup interactions (§11.8)
    X["td_matchup"] = (A["off_td_a"] + A["off_td_l"] + B["def_td_l"]) - (B["off_td_a"] + B["off_td_l"] + A["def_td_l"])
    X["strike_matchup"] = (A["off_stand_l"] + B["def_stand_l"]) - (B["off_stand_l"] + A["def_stand_l"])
    X["sub_matchup"] = (A["off_sub_att"] + B["def_sub_att"]) - (B["off_sub_att"] + A["def_sub_att"])
    X["ko_matchup"] = (A["off_kd"] + B["def_kd"]) - (B["off_kd"] + A["def_kd"])
    sa = (A["stance"] == "Southpaw").astype(float); sb = (B["stance"] == "Southpaw").astype(float)
    X["southpaw_edge"] = sa - sb
    if ctx is not None:
        hw = (ctx["weight_class"].values == "Heavyweight").astype(float)
        X["age_hw"] = X["age"] * hw
    else:
        X["age_hw"] = 0.0
    return X.fillna(0.0)
