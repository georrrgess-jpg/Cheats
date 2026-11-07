"""Odds intake (§4.2, §7.4): BestFightOdds event pages, data/odds_input.csv, raw pastes.

Every quote becomes a row: snapshot_ts, source, book, bout_key, key (probability key, see markets.py),
group (devig group), market (code), american, decimal. Odds are never guessed: unparseable lines are logged.
"""
from __future__ import annotations

import html
import logging
import re
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from bs4 import BeautifulSoup

from .devig import american_to_decimal
from .names import norm, resolve, strip_accents
from .util import ROOT, cfg, now_utc

log = logging.getLogger("ufc.odds")

COLS = ["snapshot_ts", "source", "book", "bout_key", "side_a_name", "key", "group", "market", "line", "american", "decimal", "label"]


def market_of(key: str) -> str:
    k = key[4:] if key.startswith("NOT:") else key
    head = k.split("|")[0]
    return {"SIG": "SIG_OU", "TD": "TD_OU"}.get(head, head) if not (head == "SIG" and "|TOT|" in k) else "SIG_TOT_OU"


def group_of_key(key: str) -> str:
    k = key[4:] if key.startswith("NOT:") else key
    p = k.split("|")
    if p[0] == "ML":
        return "ML"
    if p[0] in ("ROUNDS_OU", "TIME_OU"):
        return f"{p[0]}|{p[2]}"
    if p[0] in ("SIG", "TD"):
        return f"{p[0]}|{p[1]}|{p[3]}"
    if p[0] in ("MOST_SIG", "MOST_TD"):
        return p[0]
    if p[0] == "DRAW":
        return "DRAW"
    if p[0] == "DIST":
        return "DIST"
    if p[0] == "KD" and p[1] in ("YES", "NO"):
        return "KD"
    return k


def _parse_american(s: str):
    m = re.search(r"([+-]\d{3,5})", s or "")
    return float(m.group(1)) if m else None


def _book_name(s: str) -> str:
    s = re.sub(r"\$\d+.*$", "", s.strip())
    return s.strip() or "?"


def label_to_key(label: str, nameA: list[str], nameB: list[str], prev_key: str | None):
    """Map a BestFightOdds prop label to a probability key. nameA/nameB: name variants for each side."""
    lab = html.unescape(html.unescape(label)).replace("½", ".5").strip()
    lab = strip_accents(lab)
    if lab == "Any other result":
        return ("NOT:" + prev_key) if prev_key and not prev_key.startswith("NOT:") else None
    side = None
    for s, variants in (("A", nameA), ("B", nameB)):
        for v in sorted(variants, key=len, reverse=True):
            v2 = strip_accents(v)
            for pre in ("Not ", ""):
                if lab.startswith(pre + v2 + " "):
                    side = s
                    lab = pre + "{S}" + lab[len(pre) + len(v2):]
                    break
            if side:
                break
        if side:
            break
    m = re.match(r"^(Over|Under) (\d)\.5 rounds$", lab)
    if m:
        return f"ROUNDS_OU|{m.group(1).upper()}|{m.group(2)}.5"
    simple = {"Fight goes to decision": "DIST|YES", "Fight doesn't go to decision": "DIST|NO",
              "Fight is a draw": "DRAW|YES", "Fight is not a draw": "DRAW|NO",
              "Fight ends in round 1 or 2": "ROUND_GRP|ANY:R1-2",
              "Fight ends in final round or goes to decision": "ROUND_GRP|ANY:FINAL_OR_DEC",
              "Either fighter wins by TKO/KO": "METHOD3|KO", "Either fighter wins by submission": "METHOD3|SUB"}
    if lab in simple:
        return simple[lab]
    m = re.match(r"^Fight (starts|won't start) round (\d)$", lab)
    if m:
        k = f"START_RD|YES|{m.group(2)}"
        return k if m.group(1) == "starts" else "NOT:" + k
    m = re.match(r"^Fight (ends|doesn't end) in round (\d)$", lab)
    if m:
        k = f"END_RD|YES|{m.group(2)}"
        return k if m.group(1) == "ends" else "NOT:" + k
    m = re.match(r"^Fight ends in (TKO/KO/DQ|submission) in round (\d)$", lab)
    if m:
        return f"RD_METHOD|ANY:{'KO' if 'TKO' in m.group(1) else 'SUB'}:R{m.group(2)}"
    if side is None:
        return None
    S = side
    pats = [
        (r"^\{S\} wins by TKO/KO$", f"METHOD|{S}:KO"), (r"^\{S\} wins by submission$", f"METHOD|{S}:SUB"),
        (r"^\{S\} wins by decision$", f"METHOD|{S}:DEC"), (r"^\{S\} wins inside distance$", f"ITD|{S}"),
        (r"^Not \{S\} inside distance$", f"NOT:ITD|{S}"), (r"^Not \{S\} by decision$", f"NOT:METHOD|{S}:DEC"),
        (r"^\{S\} wins in round 1 or 2$", f"ROUND_GRP|{S}:R1-2"), (r"^\{S\} wins in round 3 or 4$", f"ROUND_GRP|{S}:R3-4"),
        (r"^\{S\} wins in final round or by decision$", f"ROUND_GRP|{S}:FINAL_OR_DEC"),
        (r"^\{S\} wins by unanimous decision$", f"DEC_TYPE|{S}:U"),
        (r"^\{S\} wins by split/majority decision$", f"DEC_TYPE|{S}:SM"),
        (r"^\{S\} has more takedowns$", f"MOST_TD|{S}"), (r"^\{S\} has more significant strikes$", f"MOST_SIG|{S}"),
    ]
    for pat, key in pats:
        if re.match(pat, lab):
            return key
    m = re.match(r"^\{S\} wins in round (\d)$", lab)
    if m:
        return f"ROUND|{S}:R{m.group(1)}"
    m = re.match(r"^\{S\} wins by (TKO/KO|submission) in round (\d)$", lab)
    if m:
        return f"RD_METHOD|{S}:{'KO' if 'TKO' in m.group(1) else 'SUB'}:R{m.group(2)}"
    return None


def fetch_bfo(url: str, force: bool = True) -> str:
    c = cfg()
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    cache = ROOT / "data/raw_cache/bfo" / f"{slug}.html"
    if cache.exists() and not force:
        return cache.read_text()
    for attempt in range(c["data"]["max_retries"]):
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": c["data"]["user_agent"]})
            r.raise_for_status()
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(r.text)
            time.sleep(c["data"]["request_delay_s"])
            return r.text
        except Exception as e:  # pragma: no cover - network
            log.warning("BFO fetch failed %s (%s)", url, e)
            time.sleep(2 ** (attempt + 1))
    if cache.exists():
        log.warning("using cached BFO page for %s", url)
        return cache.read_text()
    raise RuntimeError(f"cannot fetch {url}")


def parse_bfo(page: str, card: pd.DataFrame, fighter_ids: dict, ts=None, source="bestfightodds") -> tuple[pd.DataFrame, list]:
    """card has bout_key, a_id, b_id, fighter_a, fighter_b. fighter_ids: {fighter_id: name} for tonight."""
    ts = ts or now_utc().isoformat()
    soup = BeautifulSoup(page, "lxml")
    tabs = soup.select("table.odds-table")
    if len(tabs) < 2:
        return pd.DataFrame(columns=COLS), ["no odds table"]
    t = tabs[1]
    books = [_book_name(th.get_text(" ", strip=True)) for th in t.select("thead th")][1:]
    rows = t.select("tbody tr")
    out, issues = [], []
    from .names import load_overrides
    ov = load_overrides()
    by_ids = {frozenset((r.a_id, r.b_id)): r for r in card.itertuples()}
    i = 0
    cur = None
    prev_key = None
    pending = []
    while i < len(rows):
        r = rows[i]
        cls = r.get("class") or []
        cells = r.find_all(["th", "td"])
        label = cells[0].get_text(strip=True)
        prices = [_parse_american(c.get_text(strip=True)) for c in cells[1:1 + len(books)]]
        if "pr" not in cls:
            # matchup = this row + next row
            r2 = rows[i + 1] if i + 1 < len(rows) else None
            n1 = label
            n2 = r2.find_all(["th", "td"])[0].get_text(strip=True) if r2 is not None else ""
            p2 = [_parse_american(c.get_text(strip=True)) for c in r2.find_all(["th", "td"])[1:1 + len(books)]] if r2 is not None else []
            f1, h1, _ = resolve(n1, fighter_ids, ov)
            f2, h2, _ = resolve(n2, fighter_ids, ov)
            cur = by_ids.get(frozenset((f1, f2))) if f1 and f2 else None
            if cur is None:
                issues.append(f"BFO matchup not on card: {n1} vs {n2} ({h1}/{h2})")
            else:
                first_is_a = f1 == cur.a_id
                nameA = [n1 if first_is_a else n2]; nameB = [n2 if first_is_a else n1]
                for nm, lst in ((cur.fighter_a, nameA), (cur.fighter_b, nameB)):
                    lst += [nm, nm.split()[-1], strip_accents(nm.split()[-1])]
                    lst.append(lst[0].split()[-1])
                cur_names = (nameA, nameB)
                for nm, pr, isa in ((n1, prices, first_is_a), (n2, p2, not first_is_a)):
                    for b, a in zip(books, pr):
                        if a is not None:
                            out.append([ts, source, b, cur.bout_key, cur.fighter_a, f"ML|{'A' if isa else 'B'}", "ML",
                                        "ML", np.nan, a, american_to_decimal(a), nm])
            prev_key = None
            i += 2
            continue
        if cur is not None:
            key = label_to_key(label, cur_names[0], cur_names[1], prev_key)
            if key is None:
                issues.append(f"{cur.bout_key}: unparsed prop '{html.unescape(label)}'")
                prev_key = None      # never pair a following 'Any other result' with the wrong prop
            else:
                for b, a in zip(books, prices):
                    if a is not None:
                        line = np.nan
                        mm = re.search(r"\|(\d+(?:\.\d+)?)$", key)
                        if mm:
                            line = float(mm.group(1))
                        out.append([ts, source, b, cur.bout_key, cur.fighter_a, key, group_of_key(key), market_of(key),
                                    line, a, american_to_decimal(a), html.unescape(label)])
                prev_key = key
        i += 1
    df = pd.DataFrame(out, columns=COLS)
    return df.drop_duplicates(["book", "bout_key", "key"], keep="first"), issues


# ------------------------------------------------------------------ odds_input.csv
TEMPLATE = """bout,market,selection,line,american_odds,book,timestamp
#EXAMPLE Cortes-Acosta-Walker,ML,Johnny Walker,,+190,ExampleBook,2026-11-07T20:00:00Z
#EXAMPLE Cortes-Acosta-Walker,SIG_OU,Johnny Walker:OVER,45.5,-115,ExampleBook,2026-11-07T20:00:00Z
"""


def ensure_template(path: Path):
    if not path.exists():
        path.write_text(TEMPLATE)


def csv_selection_to_key(market: str, sel: str, line, side_of) -> str | None:
    """side_of(name) -> 'A'/'B'/None. Returns probability key or None."""
    sel = str(sel).strip()
    ln = None if pd.isna(line) or str(line).strip() == "" else float(line)
    fs = lambda s: side_of(s)
    up = sel.upper()
    if market == "ML":
        if up == "DRAW":
            return "DRAW|YES"
        s = fs(sel); return f"ML|{s}" if s else None
    if market == "METHOD":
        nm, k = sel.rsplit(":", 1); s = fs(nm); return f"METHOD|{s}:{k.upper()}" if s else None
    if market == "METHOD3":
        return f"METHOD3|{up}"
    if market == "ITD":
        s = fs(sel); return f"ITD|{s}" if s else None
    if market == "DIST":
        return f"DIST|{up}"
    if market == "ROUND":
        if up == "DEC":
            return "ROUND|DEC"
        nm, r = sel.rsplit(":", 1); s = fs(nm); return f"ROUND|{s}:{r.upper()}" if s else None
    if market == "ROUNDS_OU":
        return f"ROUNDS_OU|{up}|{ln}"
    if market == "START_RD":
        k = f"START_RD|YES|{int(ln)}"; return k if up == "YES" else "NOT:" + k
    if market == "TIME_OU":
        return f"TIME_OU|{up}|{ln}"
    if market in ("SIG_OU", "TD_OU"):
        nm, ou = sel.rsplit(":", 1); s = fs(nm)
        return f"{'SIG' if market == 'SIG_OU' else 'TD'}|{s}|{ou.upper()}|{ln}" if s else None
    if market == "SIG_TOT_OU":
        return f"SIG|TOT|{up}|{ln}"
    if market == "KD":
        if up in ("YES", "NO"):
            return f"KD|{up}"
        nm, yn = sel.rsplit(":", 1); s = fs(nm)
        return (f"KD|{s}" if yn.upper() == "YES" else f"NOT:KD|{s}") if s else None
    return None


def read_odds_csv(path: Path, card: pd.DataFrame) -> tuple[pd.DataFrame, list]:
    ensure_template(path)
    df = pd.read_csv(path, comment="#", dtype=str)
    out, issues = [], []
    for r in df.itertuples(index=False):
        if not isinstance(r.bout, str) or r.bout.startswith("#"):
            continue
        b = match_bout(r.bout, card)
        if b is None:
            issues.append(f"odds_input: unknown bout '{r.bout}'")
            continue
        side_of = lambda nm: side_for_name(nm, b)
        key = csv_selection_to_key(str(r.market).strip().upper(), r.selection, r.line, side_of)
        try:
            a = float(str(r.american_odds).replace("+", ""))
        except Exception:
            a = None
        if key is None or a is None:
            issues.append(f"odds_input: cannot parse row {tuple(r)}")
            continue
        line = float(r.line) if isinstance(r.line, str) and r.line.strip() else np.nan
        out.append([r.timestamp or now_utc().isoformat(), "odds_input.csv", r.book or "manual", b.bout_key, b.fighter_a,
                    key, group_of_key(key), market_of(key), line, a, american_to_decimal(a), r.selection])
    return pd.DataFrame(out, columns=COLS), issues


def match_bout(text: str, card: pd.DataFrame):
    t = norm(text.replace("-", " "))
    for r in card.itertuples():
        la = norm(r.fighter_a.split()[-1]); lb = norm(r.fighter_b.split()[-1])
        if r.bout_key.lower() == text.lower() or (la in t and lb in t):
            return r
    return None


def side_for_name(nm: str, b) -> str | None:
    n = norm(nm)
    ta, tb = set(norm(b.fighter_a).split()), set(norm(b.fighter_b).split())
    tn = set(n.split())
    sa, sb = len(tn & ta), len(tn & tb)
    if sa > sb:
        return "A"
    if sb > sa:
        return "B"
    return None


def load_all_odds(event: str, card: pd.DataFrame, fighter_ids: dict, fetch: bool = True) -> tuple[pd.DataFrame, list]:
    ecfg = cfg()["events"][event]
    frames, issues = [], []
    for url in ecfg.get("bfo_event_urls", []):
        try:
            page = fetch_bfo(url, force=fetch)
            df, iss = parse_bfo(page, card, fighter_ids)
            frames.append(df); issues += iss
        except Exception as e:
            issues.append(f"BFO {url}: {e}")
    df, iss = read_odds_csv(ROOT / "data/odds_input.csv", card)
    frames.append(df); issues += iss
    q = pd.concat([f for f in frames if len(f)], ignore_index=True) if any(len(f) for f in frames) else pd.DataFrame(columns=COLS)
    # history (§7.4): append every snapshot
    hist = ROOT / "data/odds_history.csv"
    q.to_csv(hist, mode="a", header=not hist.exists(), index=False)
    return q, issues
