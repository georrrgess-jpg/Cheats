"""Win-probability models (§13): Elo (model 1) and L2 logistic regression on antisymmetric feature
differences (model 2), trained on both orientations, no intercept => exactly symmetric:
p(A beats B) = 1 - p(B beats A). Optional gradient boosting (model 3, T2). Walk-forward evaluation
and temperature (Platt-without-intercept) calibration on out-of-fold predictions.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression

from .features import pair_matrix
from .util import cfg

log = logging.getLogger("ufc.winprob")


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def training_frame(F: pd.DataFrame, fights: pd.DataFrame, min_year: int):
    f = fights[(fights.result_type == "WIN") & fights.fighter_a_id.notna() & fights.fighter_b_id.notna()
               & (fights.date.dt.year >= min_year)]
    A = F[F.side == "A"].set_index("fight_id")
    B = F[F.side == "B"].set_index("fight_id")
    ids = [i for i in f.fight_id if i in A.index and i in B.index]
    f = f.set_index("fight_id").loc[ids].reset_index()
    X = pair_matrix(A.loc[ids], B.loc[ids], f)
    y = (f["winner_id"].values == f["fighter_a_id"].values).astype(int)
    meta = f[["fight_id", "date", "weight_class", "gender", "scheduled_rounds", "fighter_a_id", "fighter_b_id"]].copy()
    meta["elo_p"] = 1.0 / (1.0 + 10 ** ((B.loc[ids, "elo"].values - A.loc[ids, "elo"].values) / cfg()["elo"]["scale"]))
    meta["min_n"] = np.minimum(A.loc[ids, "n_fights"].values, B.loc[ids, "n_fights"].values)
    return X, y, meta


class LRModel:
    def __init__(self, C=0.5):
        self.C = C
        self.cols = None

    def fit(self, X: pd.DataFrame, y: np.ndarray, w: np.ndarray | None = None):
        self.cols = list(X.columns)
        Xm = np.vstack([X.values, -X.values])
        ym = np.concatenate([y, 1 - y])
        wm = None if w is None else np.concatenate([w, w])
        self.scale = Xm.std(axis=0) + 1e-9
        self.m = LogisticRegression(C=self.C, fit_intercept=False, max_iter=2000)
        self.m.fit(Xm / self.scale, ym, sample_weight=wm)
        # approximate coefficient covariance (Laplace): inv(X'WX + I/C)
        Z = Xm / self.scale
        p = sigmoid(Z @ self.m.coef_[0])
        H = (Z * (p * (1 - p))[:, None]).T @ Z + np.eye(Z.shape[1]) / self.C
        self.cov = np.linalg.inv(H)
        return self

    def logit(self, X: pd.DataFrame) -> np.ndarray:
        return (X[self.cols].values / self.scale) @ self.m.coef_[0]

    def logit_se(self, X: pd.DataFrame) -> np.ndarray:
        Z = X[self.cols].values / self.scale
        return np.sqrt(np.einsum("ij,jk,ik->i", Z, self.cov, Z))

    def contributions(self, X: pd.DataFrame) -> pd.DataFrame:
        Z = X[self.cols].values / self.scale
        return pd.DataFrame(Z * self.m.coef_[0], columns=self.cols, index=X.index)


class GBModel:
    """Model 3 (T2): sklearn HistGradientBoosting on the mirrored differences, symmetrized at predict."""

    def __init__(self, seed=0):
        self.seed = seed

    def fit(self, X, y):
        from sklearn.ensemble import HistGradientBoostingClassifier
        self.cols = list(X.columns)
        Xm = np.vstack([X.values, -X.values]); ym = np.concatenate([y, 1 - y])
        self.m = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.04, max_leaf_nodes=15,
                                                min_samples_leaf=80, l2_regularization=1.0, random_state=self.seed)
        self.m.fit(Xm, ym)
        return self

    def logit(self, X):
        v = X[self.cols].values
        pa = self.m.predict_proba(v)[:, 1]
        pb = self.m.predict_proba(-v)[:, 1]
        return logit(0.5 * (pa + (1 - pb)))


def fit_temperature(z: np.ndarray, y: np.ndarray) -> float:
    def nll(a):
        p = np.clip(sigmoid(a * z), 1e-9, 1 - 1e-9)
        return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    return float(minimize_scalar(nll, bounds=(0.2, 3.0), method="bounded").x)


def metrics(p, y) -> dict:
    p = np.clip(np.asarray(p, float), 1e-9, 1 - 1e-9)
    y = np.asarray(y, float)
    ll = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
    br = np.mean((p - y) ** 2)
    # ECE on the "favorite" orientation, 10 bins
    pf = np.where(p >= 0.5, p, 1 - p); yf = np.where(p >= 0.5, y, 1 - y)
    bins = np.clip(((pf - 0.5) / 0.05).astype(int), 0, 9)
    ece = sum(abs(pf[bins == b].mean() - yf[bins == b].mean()) * (bins == b).mean() for b in range(10) if (bins == b).any())
    acc = np.mean((p >= 0.5) == (y == 1))
    return {"n": int(len(y)), "log_loss": float(ll), "brier": float(br), "ece": float(ece), "accuracy": float(acc)}


def reliability(p, y, nb=10) -> pd.DataFrame:
    p = np.asarray(p); y = np.asarray(y)
    edges = np.linspace(0, 1, nb + 1)
    b = np.clip(np.digitize(p, edges) - 1, 0, nb - 1)
    return pd.DataFrame([{"bin": f"{edges[i]:.1f}-{edges[i+1]:.1f}", "n": int((b == i).sum()),
                          "mean_pred": float(p[b == i].mean()) if (b == i).any() else np.nan,
                          "hit_rate": float(y[b == i].mean()) if (b == i).any() else np.nan} for i in range(nb)])


def walk_forward(X, y, meta, start: str, C: float, use_gb: bool = False, seed: int = 0) -> pd.DataFrame:
    """Monthly refit. Returns OOF rows with raw LR logit, (optional) GB logit, Elo prob."""
    months = pd.date_range(pd.Timestamp(start), meta.date.max() + pd.offsets.MonthBegin(1), freq="MS")
    out = []
    for m0, m1 in zip(months[:-1], months[1:]):
        tr = (meta.date < m0).values
        te = ((meta.date >= m0) & (meta.date < m1)).values
        if te.sum() == 0:
            continue
        lr = LRModel(C).fit(X[tr], y[tr])
        o = meta[te].copy()
        o["y"] = y[te]
        o["z_lr"] = lr.logit(X[te])
        if use_gb and (m0.month % 3 == 1):   # refit GB quarterly (slower)
            gb = GBModel(seed).fit(X[tr], y[tr])
        if use_gb:
            o["z_gb"] = gb.logit(X[te])
        out.append(o)
    return pd.concat(out, ignore_index=True)
