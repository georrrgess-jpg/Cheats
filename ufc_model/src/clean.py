"""Parsing helpers and cleaning rules for UFCStats-format data (§9)."""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

WEIGHT_CLASSES = {
    "Strawweight": 115, "Flyweight": 125, "Bantamweight": 135, "Featherweight": 145,
    "Lightweight": 155, "Welterweight": 170, "Middleweight": 185, "Light Heavyweight": 205,
    "Heavyweight": 265,
}
WC_ORDER = list(WEIGHT_CLASSES)


def of_pair(s) -> tuple[float, float]:
    """'12 of 30' -> (12, 30). Missing -> (nan, nan)."""
    if not isinstance(s, str):
        return (np.nan, np.nan)
    m = re.match(r"\s*(\d+)\s+of\s+(\d+)", s)
    if not m:
        return (np.nan, np.nan)
    return (float(m.group(1)), float(m.group(2)))


def mmss(s) -> float:
    """'4:07' -> 247 seconds; '--' -> nan."""
    if not isinstance(s, str):
        return np.nan
    m = re.match(r"\s*(\d+):(\d+)", s)
    return float(int(m.group(1)) * 60 + int(m.group(2))) if m else np.nan


def parse_weight_class(wc: str) -> tuple[str, str, bool, bool]:
    """Returns (weight_class, gender, is_title, is_catchweight)."""
    wc = (wc or "").strip()
    gender = "F" if "Women" in wc else "M"
    is_title = "Title" in wc
    for name in sorted(WEIGHT_CLASSES, key=len, reverse=True):
        if name in wc:
            return name, gender, is_title, False
    return "Catchweight", gender, is_title, True


def map_catchweight(lbs: float | None, gender: str) -> str:
    """Nearest division by contracted weight (§9)."""
    if lbs is None or not np.isfinite(lbs):
        return "Catchweight"
    choices = WEIGHT_CLASSES if gender == "M" else {k: v for k, v in WEIGHT_CLASSES.items()
                                                     if k in ("Strawweight", "Flyweight", "Bantamweight", "Featherweight")}
    return min(choices, key=lambda k: abs(choices[k] - lbs))


def parse_format(fmt: str) -> list[int]:
    """'3 Rnd (5-5-5)' -> [300,300,300]. Unknown -> [300]*3."""
    m = re.search(r"\(([\d\-]+)\)", fmt or "")
    if not m:
        if "No Time Limit" in (fmt or ""):
            return [3600]
        return [300, 300, 300]
    return [int(x) * 60 for x in m.group(1).split("-") if x]


def method_bucket(method: str, details: str = "") -> tuple[str, str]:
    """Returns (result_type, method) where result_type in {WIN, DRAW, NC} and method in
    KO, SUB, U-DEC, S-DEC, M-DEC, DQ, DOC (doctor stoppage / could not continue), OTHER, OVERTURNED."""
    m = (method or "").strip().lower()
    if m.startswith("ko/tko"):
        return "KO"
    if "doctor" in m or "could not continue" in m:
        return "DOC"
    if m.startswith("submission"):
        return "SUB"
    if "decision - unanimous" in m:
        return "U-DEC"
    if "decision - split" in m:
        return "S-DEC"
    if "decision - majority" in m:
        return "M-DEC"
    if m.startswith("dq"):
        return "DQ"
    if "overturned" in m:
        return "OVERTURNED"
    if "tko" in m:
        return "KO"
    if "decision" in m:
        return "U-DEC"
    return "OTHER"


def market_method(m: str, dq_counts_as_ko: bool = True) -> str:
    """Collapse simulator/historical method to the 3 market buckets KO/SUB/DEC (+DRAW/NC)."""
    if m in ("KO", "DOC"):
        return "KO"
    if m == "DQ":
        return "KO" if dq_counts_as_ko else "OTHER"
    if m == "SUB":
        return "SUB"
    if m in ("U-DEC", "S-DEC", "M-DEC", "DEC"):
        return "DEC"
    return m


def height_in(s) -> float:
    if not isinstance(s, str):
        return np.nan
    m = re.match(r"\s*(\d+)'\s*(\d+)", s)
    return float(int(m.group(1)) * 12 + int(m.group(2))) if m else np.nan


def reach_in(s) -> float:
    if not isinstance(s, str):
        return np.nan
    m = re.match(r"\s*(\d+(?:\.\d+)?)", s)
    return float(m.group(1)) if m else np.nan


def parse_date(s) -> pd.Timestamp:
    try:
        return pd.to_datetime(s)
    except Exception:
        return pd.NaT
