#!/usr/bin/env python
"""Parse a raw sportsbook paste into data/odds_input.csv (§4.2). Never guesses a line or a price.

  python parse_paste.py paste.txt [--book FanDuel] [--event "UFC Vegas 124"]

Handles the common layouts:
  "Johnny Walker Over 45.5 Significant Strikes -115"     -> SIG_OU
  "Total Significant Strikes Over 99.5 -110"             -> SIG_TOT_OU (bout from the nearest header line)
  "Walker Takedowns Over 0.5 +150"                       -> TD_OU
  "Over 2.5 Rounds -130" / "Fight goes the distance Yes -150"
  "Walker by KO/TKO +300" / "Walker by Submission +900" / "Walker by Decision +400"
  "Knockdown Yes +200"; a line with two fighter names sets the current bout.
Odds may be on the same line or the next line. Lines it can't place confidently go to the
'unparsed' list so they can be confirmed.
"""
from __future__ import annotations

import argparse
import re
import sys

import pandas as pd

from src.names import norm, strip_accents
from src.scrape_card import load_card
from src.util import ROOT, cfg, now_utc

ODDS = re.compile(r"(?<![\d.])([+-]\d{3,4}|EVEN|EV)(?![\d.])", re.I)
NUM = re.compile(r"(\d+(?:\.\d)?)")


def parse(text: str, card: pd.DataFrame, book: str):
    lines = [strip_accents(l).strip() for l in text.splitlines()]
    lines = [l for l in lines if l]
    rows, unparsed = [], []
    cur = None
    names = {}
    for r in card.itertuples():
        for side, nm in (("A", r.fighter_a), ("B", r.fighter_b)):
            for v in {nm, nm.split()[-1], strip_accents(nm.split()[-1]), strip_accents(nm)}:
                names.setdefault(v.lower(), []).append((r, side, nm))
    i = 0
    while i < len(lines):
        l = lines[i]
        low = l.lower()
        hits = [(v, t) for v, ts in names.items() for t in ts if re.search(r"\b" + re.escape(v) + r"\b", low)]
        bouts = {t[0].bout_key for _, t in hits}
        if len({t[2] for _, t in hits}) >= 2 and len(bouts) == 1 and not ODDS.search(l):
            cur = hits[0][1][0]
            i += 1
            continue
        m = ODDS.search(l)
        odds_txt = m.group(1) if m else None
        if odds_txt is None and i + 1 < len(lines) and ODDS.fullmatch(lines[i + 1].strip()):
            odds_txt = lines[i + 1].strip(); i += 1
        if odds_txt is None:
            i += 1
            continue
        odds = 100.0 if odds_txt.upper() in ("EVEN", "EV") else float(odds_txt)
        body = ODDS.sub("", l).strip()
        lb = body.lower()
        fighter = None
        if hits:
            r, side, nm = max(hits, key=lambda h: len(h[0]))[1]
            if cur is None or r.bout_key == cur.bout_key:
                cur = r
                fighter = nm
        if cur is None:
            unparsed.append(l); i += 1; continue
        ou = "OVER" if re.search(r"\bover\b|\bo\s?\d", lb) else ("UNDER" if re.search(r"\bunder\b|\bu\s?\d", lb) else None)
        nums = [float(x) for x in NUM.findall(re.sub(r"[+-]\d{3,4}", "", body))]
        line = nums[-1] if nums else None
        mk = sel = None
        if "sig" in lb or "significant" in lb or "strikes" in lb:
            if ou and line is not None:
                if fighter and "total" not in lb and "combined" not in lb:
                    mk, sel = "SIG_OU", f"{fighter}:{ou}"
                else:
                    mk, sel = "SIG_TOT_OU", ou
        elif "takedown" in lb:
            if ou and line is not None and fighter:
                mk, sel = "TD_OU", f"{fighter}:{ou}"
        elif "round" in lb and ou and line is not None:
            mk, sel = "ROUNDS_OU", ou
        elif "distance" in lb:
            mk, sel = "DIST", "NO" if re.search(r"\bno\b|not|doesn", lb) else "YES"
        elif "knockdown" in lb:
            mk, sel = "KD", "NO" if re.search(r"\bno\b", lb) else "YES"
            if fighter and sel == "YES":
                sel = f"{fighter}:YES"
        elif fighter and re.search(r"ko|tko", lb):
            mk, sel = "METHOD", f"{fighter}:KO"
        elif fighter and "sub" in lb:
            mk, sel = "METHOD", f"{fighter}:SUB"
        elif fighter and ("decision" in lb or "points" in lb):
            mk, sel = "METHOD", f"{fighter}:DEC"
        elif fighter and len(body.split()) <= 3:
            mk, sel = "ML", fighter
        if mk is None:
            unparsed.append(l)
        else:
            rows.append({"bout": cur.bout_key, "market": mk, "selection": sel,
                         "line": line if mk in ("SIG_OU", "SIG_TOT_OU", "TD_OU", "ROUNDS_OU") else "",
                         "american_odds": f"{odds:+.0f}", "book": book, "timestamp": now_utc().isoformat()})
        i += 1
    return pd.DataFrame(rows), unparsed


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("paste")
    ap.add_argument("--book", default="manual")
    ap.add_argument("--event", default="UFC Vegas 124")
    a = ap.parse_args(argv)
    card = load_card(a.event)
    df, un = parse(open(a.paste).read(), card, a.book)
    path = ROOT / "data/odds_input.csv"
    from src.odds import ensure_template
    ensure_template(path)
    df.to_csv(path, mode="a", header=False, index=False)
    print(f"parsed {len(df)} lines across {df.bout.nunique() if len(df) else 0} bouts -> {path}")
    if un:
        print("COULD NOT PARSE (please confirm):")
        for u in un:
            print("  ", u)
    return 0


if __name__ == "__main__":
    sys.exit(main())
