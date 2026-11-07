"""Build/verify the fight card (§2). Sources: ESPN public scoreboard API (bout list, order, segment
start times, scheduled rounds) cross-checked with the Wikipedia event page (bout list, changes).
UFC.com returns 403 and UFCStats.com serves a JS bot check from this environment, so neither is used.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import pandas as pd
import requests

from .names import last_name_key, norm, strip_accents
from .util import ROOT, cfg

log = logging.getLogger("ufc.card")
ESPN = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates={ymd}"
WIKI = "https://en.wikipedia.org/w/api.php?action=parse&page={page}&prop=wikitext&format=json&formatversion=2"


def _get(url: str, cache: Path, force: bool = False) -> str:
    if cache.exists() and not force:
        return cache.read_text()
    r = requests.get(url, timeout=30, headers={"User-Agent": cfg()["data"]["user_agent"]})
    r.raise_for_status()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(r.text)
    return r.text


def espn_card(date: str, force: bool = True) -> pd.DataFrame:
    ymd = date.replace("-", "")
    raw = _get(ESPN.format(ymd=ymd), ROOT / f"data/raw_cache/espn_scoreboard_{date}.json", force)
    d = json.loads(raw)
    rows = []
    for e in d.get("events", []):
        for i, c in enumerate(e.get("competitions", [])):
            comp = c.get("competitors", [])
            if len(comp) != 2:
                continue
            wc = (c.get("type") or {}).get("abbreviation", "")
            rows.append({
                "event_name_espn": e.get("name"), "espn_order": i + 1,
                "espn_a": comp[0]["athlete"]["displayName"], "espn_b": comp[1]["athlete"]["displayName"],
                "weight_class_espn": wc,
                "scheduled_rounds": (c.get("format") or {}).get("regulation", {}).get("periods", 3),
                "start_time_utc": c.get("date"),
                "status": (c.get("status") or {}).get("type", {}).get("description"),
            })
    return pd.DataFrame(rows)


def wiki_card(page: str, force: bool = True) -> tuple[list[dict], str]:
    raw = _get(WIKI.format(page=page), ROOT / f"data/raw_cache/wiki_{norm(page).replace(' ', '_')}.json", force)
    t = json.loads(raw)["parse"]["wikitext"]
    bouts, seg = [], None
    for block in re.split(r"\{\{MMAevent ", t):
        if block.startswith("card"):
            seg = "main" if "Preliminary" not in block.split("}}")[0] else "prelim"
        if block.startswith("bout"):
            parts = [x.strip() for x in block.split("}}")[0].split("|")[1:]]
            clean = lambda s: re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s).strip()
            bouts.append({"wc": clean(parts[0]), "a": clean(parts[1]), "b": clean(parts[3]), "segment": seg})
    a = t.find("==Background==")
    b = t.find("==Fight card==")
    bg = re.sub(r"<ref.*?(/>|</ref>)", "", t[a:b], flags=re.S)
    return bouts, bg


def build_card(event: str, wiki_page: str | None = None) -> pd.DataFrame:
    """Merge ESPN and Wikipedia; write data/cards/<event>.csv. Ordering = ESPN order (first bout first)."""
    ecfg = cfg()["events"][event]
    esp = espn_card(ecfg["date"])
    rows = []
    for _, r in esp.iterrows():
        rows.append({"bout_order": int(r.espn_order), "fighter_a": r.espn_a, "fighter_b": r.espn_b,
                     "weight_class": r.weight_class_espn, "scheduled_rounds": int(r.scheduled_rounds),
                     "start_time_utc": r.start_time_utc, "status": r.status})
    card = pd.DataFrame(rows)
    if wiki_page:
        wb, _ = wiki_card(wiki_page)
        wset = {frozenset(map(lambda s: last_name_key(s).lower(), (w["a"], w["b"]))): w for w in wb}
        card["wiki_match"] = [frozenset((last_name_key(a).lower(), last_name_key(b).lower())) in wset
                              for a, b in zip(card.fighter_a, card.fighter_b)]
    return card


def bout_key(a: str, b: str) -> str:
    return f"{last_name_key(a)}-{last_name_key(b)}"


def load_card(event: str) -> pd.DataFrame:
    path = ROOT / cfg()["events"][event]["card_file"]
    card = pd.read_csv(path)
    card["bout_key"] = [bout_key(a, b) for a, b in zip(card.fighter_a, card.fighter_b)]
    card = card.sort_values("bout_order").reset_index(drop=True)
    return card
