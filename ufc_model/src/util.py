"""Shared helpers: config, logging, run IDs, paths."""
from __future__ import annotations

import datetime as dt
import logging
import os
import random
import uuid
from pathlib import Path

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
_CFG = None


def cfg(path: str | None = None) -> dict:
    global _CFG
    if _CFG is None or path:
        with open(path or ROOT / "config.yaml") as f:
            _CFG = yaml.safe_load(f)
    return _CFG


def p(rel: str) -> Path:
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def new_run_id() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]


def setup_logging(run_id: str) -> logging.Logger:
    log = logging.getLogger("ufc")
    if log.handlers:
        return log
    log.setLevel(logging.DEBUG)
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%H:%M:%S"))
    fh = logging.FileHandler(p("output/run.log"))
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter(f"%(asctime)s [{run_id}] %(levelname)s %(name)s %(message)s"))
    log.addHandler(ch)
    log.addHandler(fh)
    return log


def seed_all(seed: int) -> np.random.Generator:
    random.seed(seed)
    np.random.seed(seed % (2**32))
    return np.random.default_rng(seed)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def load_env():
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / ".env")
    except Exception:
        pass
    return os.environ.get("ODDS_API_KEY")
