"""Name normalization and matching across sources (§8.2). Never guesses: unmatched names are reported."""
from __future__ import annotations

import csv
import difflib
import re
import unicodedata
from pathlib import Path

from .util import ROOT


def strip_accents(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def norm(s: str) -> str:
    """lowercase, strip accents, hyphens->space, drop punctuation, collapse whitespace, sort tokens."""
    s = strip_accents(str(s)).lower().replace("-", " ")
    s = re.sub(r"[^a-z0-9 ]", "", s)
    toks = sorted(t for t in s.split() if t)
    return " ".join(toks)


def tokens(s: str) -> set[str]:
    return set(norm(s).split())


def load_overrides(path: Path | None = None) -> dict[str, str]:
    path = path or ROOT / "data/name_overrides.csv"
    out = {}
    if path.exists():
        with open(path) as f:
            for row in csv.DictReader(f):
                if row.get("source_name") and row.get("fighter_id"):
                    out[norm(row["source_name"])] = row["fighter_id"].strip()
    return out


def similarity(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def resolve(name: str, candidates: dict[str, str], overrides: dict[str, str] | None = None,
            threshold: float = 0.86) -> tuple[str | None, str, float]:
    """Resolve `name` against candidates {fighter_id: display_name}.
    Returns (fighter_id or None, how, score). how in override/exact/fuzzy/subset/unmatched/ambiguous."""
    overrides = overrides or {}
    n = norm(name)
    if n in overrides and overrides[n] in candidates:
        return overrides[n], "override", 1.0
    exact = [fid for fid, nm in candidates.items() if norm(nm) == n]
    if len(exact) == 1:
        return exact[0], "exact", 1.0
    if len(exact) > 1:
        return None, "ambiguous", 1.0
    # token subset (e.g. 'Nina Nikolija Milosevic' vs 'Nina Milosevic', 'Jose Delano' vs 'Jose Mauro Delano')
    t = tokens(name)
    subs = [fid for fid, nm in candidates.items()
            if len(t & tokens(nm)) >= 2 and (t <= tokens(nm) or tokens(nm) <= t)]
    if len(subs) == 1:
        return subs[0], "subset", 0.95
    scored = sorted(((similarity(name, nm), fid) for fid, nm in candidates.items()), reverse=True)
    if scored and scored[0][0] >= threshold and (len(scored) == 1 or scored[0][0] - scored[1][0] > 0.03):
        return scored[0][1], "fuzzy", scored[0][0]
    return None, "unmatched", scored[0][0] if scored else 0.0


def last_name_key(name: str) -> str:
    """Bout key component: the last name with accents stripped, hyphens kept (Cortes-Acosta)."""
    s = strip_accents(name).strip()
    return re.sub(r"[^A-Za-z\-]", "", s.split()[-1])
