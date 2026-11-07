#!/usr/bin/env python
"""Snapshot odds every N minutes until each bout starts; the last snapshot before a bout's (estimated)
start is its closing line (§25). Writes data/odds_history.csv and data/closing_lines.csv.

  python watch_odds.py --event "UFC Vegas 124" --every 12 [--once]
Bout start is estimated as segment start + 25 min x position within the segment (configurable below);
closing lines are re-marked on every snapshot, so a later run only improves them.
"""
from __future__ import annotations

import argparse
import time

import pandas as pd

from src.edge import consensus
from src.names import load_overrides, resolve
from src.odds import load_all_odds
from src.scrape_card import load_card
from src.store import build_tables
from src.util import ROOT, cfg, now_utc

MIN_PER_BOUT = 25


def est_starts(card: pd.DataFrame) -> dict:
    out = {}
    for seg, g in card.groupby("segment"):
        g = g.sort_values("bout_order")
        t0 = pd.Timestamp(g.start_time_utc.iloc[0])
        for j, r in enumerate(g.itertuples()):
            out[r.bout_key] = t0 + pd.Timedelta(minutes=MIN_PER_BOUT * j)
    return out


def snapshot(event, card, fids):
    q, issues = load_all_odds(event, card, fids, fetch=True)
    ts = now_utc()
    starts = est_starts(card)
    q = q.assign(snapshot_ts=ts.isoformat())
    live = q[[pd.Timestamp(starts[b]) > ts for b in q.bout_key]]
    path = ROOT / "data/closing_lines.csv"
    old = pd.read_csv(path) if path.exists() else pd.DataFrame()
    if len(live):
        cons, _ = consensus(live, cfg())
        cons["closing_ts"] = ts.isoformat()
        if len(old):
            old = old[~old.set_index(["bout_key", "key"]).index.isin(cons.set_index(["bout_key", "key"]).index)]
        pd.concat([old, cons], ignore_index=True).to_csv(path, index=False)
    return len(q), len(live), max(starts.values()) > ts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", default="UFC Vegas 124")
    ap.add_argument("--every", type=float, default=12)
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args(argv)
    T = build_tables()
    cand = dict(zip(T["fighters"].fighter_id, T["fighters"].name))
    ov = load_overrides()
    card = load_card(a.event)
    card["a_id"] = [resolve(n, cand, ov)[0] for n in card.fighter_a]
    card["b_id"] = [resolve(n, cand, ov)[0] for n in card.fighter_b]
    fids = {i: cand[i] for i in list(card.a_id) + list(card.b_id) if i}
    while True:
        n, nl, more = snapshot(a.event, card, fids)
        print(f"{now_utc():%H:%M:%S} UTC snapshot: {n} quotes, {nl} pre-start; closing lines -> data/closing_lines.csv", flush=True)
        if a.once or not more:
            break
        time.sleep(a.every * 60)


if __name__ == "__main__":
    main()
