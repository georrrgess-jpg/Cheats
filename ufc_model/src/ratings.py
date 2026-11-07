"""Elo ratings across all UFC fights (§12). Separate pools by gender (they never cross)."""
from __future__ import annotations

import math


class Elo:
    def __init__(self, k=32.0, init=1500.0, scale=400.0, debut_penalty=0.0, finish_boost=0.0):
        self.k, self.init, self.scale = k, init, scale
        self.debut_penalty, self.finish_boost = debut_penalty, finish_boost
        self.r: dict[str, float] = {}
        self.n: dict[str, int] = {}

    def get(self, fid: str) -> float:
        return self.r.get(fid, self.init + self.debut_penalty)

    def rd(self, fid: str) -> float:
        """Crude uncertainty proxy: shrinks with number of rated fights (Glicko-like RD)."""
        n = self.n.get(fid, 0)
        return 350.0 / math.sqrt(1.0 + n)

    def expect(self, ra: float, rb: float) -> float:
        return 1.0 / (1.0 + 10 ** ((rb - ra) / self.scale))

    def p(self, a: str, b: str) -> float:
        return self.expect(self.get(a), self.get(b))

    def update(self, a: str, b: str, score_a: float, finish: bool = False):
        ra, rb = self.get(a), self.get(b)
        e = self.expect(ra, rb)
        k = self.k * (1.0 + (self.finish_boost if finish else 0.0))
        # higher K while a fighter is new (faster convergence)
        ka = k * (1.5 if self.n.get(a, 0) < 3 else 1.0)
        kb = k * (1.5 if self.n.get(b, 0) < 3 else 1.0)
        self.r[a] = ra + ka * (score_a - e)
        self.r[b] = rb + kb * ((1 - score_a) - (1 - e))
        self.n[a] = self.n.get(a, 0) + 1
        self.n[b] = self.n.get(b, 0) + 1
