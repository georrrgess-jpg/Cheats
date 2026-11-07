"""Acquire the public UFCStats dataset (fast path, §7.1) and build the normalized tables (§8.1).

UFCStats.com itself now serves a JavaScript proof-of-work bot check; per §7.5 we do not get around it.
The Greco1899/scrape_ufc_stats dataset (a maintained daily scrape of UFCStats) is the source instead.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import clean
from .names import norm
from .util import ROOT, cfg

log = logging.getLogger("ufc.store")


def fetch_dataset(force: bool = False) -> Path:
    c = cfg()
    d = ROOT / c["data"]["raw_cache"] / "greco"
    d.mkdir(parents=True, exist_ok=True)
    for f in c["data"]["dataset_files"]:
        out = d / f
        if out.exists() and not force:
            continue
        url = c["data"]["dataset_base_url"] + f
        for attempt in range(c["data"]["max_retries"]):
            try:
                r = requests.get(url, timeout=60, headers={"User-Agent": c["data"]["user_agent"]})
                r.raise_for_status()
                out.write_bytes(r.content)
                log.info("downloaded %s (%d bytes)", f, len(r.content))
                break
            except Exception as e:  # pragma: no cover - network
                log.warning("download %s failed (%s), retry", f, e)
                time.sleep(2 ** (attempt + 1))
        time.sleep(c["data"]["request_delay_s"])
    return d


def _strip(df: pd.DataFrame) -> pd.DataFrame:
    for col in df.columns:
        if df[col].dtype == object or pd.api.types.is_string_dtype(df[col]):
            df[col] = df[col].str.strip()
    return df


def build_tables(force: bool = False) -> dict[str, pd.DataFrame]:
    c = cfg()
    proc = ROOT / c["data"]["processed"]
    proc.mkdir(parents=True, exist_ok=True)
    d = fetch_dataset()
    stamp = "|".join(str((d / f).stat().st_size) for f in c["data"]["dataset_files"])
    stamp_file = proc / "_stamp.txt"
    names = ["events", "fighters", "fights", "fight_rounds", "fighter_fight"]
    if not force and stamp_file.exists() and stamp_file.read_text() == stamp and all(
            (proc / f"{n}.parquet").exists() for n in names):
        return {n: pd.read_parquet(proc / f"{n}.parquet") for n in names}

    ev = _strip(pd.read_csv(d / "ufc_event_details.csv"))
    res = _strip(pd.read_csv(d / "ufc_fight_results.csv"))
    st = _strip(pd.read_csv(d / "ufc_fight_stats.csv"))
    tott = _strip(pd.read_csv(d / "ufc_fighter_tott.csv"))
    fdet = _strip(pd.read_csv(d / "ufc_fighter_details.csv"))

    # events
    ev["event_id"] = ev["URL"].str.rsplit("/", n=1).str[-1]
    ev["date"] = pd.to_datetime(ev["DATE"], errors="coerce")
    ev["is_apex"] = ev["LOCATION"].str.contains("Las Vegas", na=False) & ev["EVENT"].str.contains(
        "Fight Night|ESPN|Vegas", na=False) & (ev["date"] >= "2020-05-30")
    events = ev.rename(columns={"EVENT": "name", "LOCATION": "city"})[["event_id", "name", "date", "city", "is_apex"]]
    events["cage_size_ft"] = np.where(events["is_apex"], 25, 30)

    # fighters
    tott["fighter_id"] = tott["URL"].str.rsplit("/", n=1).str[-1]
    fdet["fighter_id"] = fdet["URL"].str.rsplit("/", n=1).str[-1]
    fighters = tott.merge(fdet[["fighter_id", "NICKNAME"]], on="fighter_id", how="left")
    fighters = pd.DataFrame({
        "fighter_id": fighters["fighter_id"], "name": fighters["FIGHTER"],
        "nickname": fighters["NICKNAME"],
        "dob": pd.to_datetime(fighters["DOB"], errors="coerce"),
        "height_in": fighters["HEIGHT"].map(clean.height_in),
        "reach_in": fighters["REACH"].map(clean.reach_in),
        "weight_lbs": fighters["WEIGHT"].map(clean.reach_in),
        "stance": fighters["STANCE"],
    }).drop_duplicates("fighter_id")
    fighters["name_norm"] = fighters["name"].map(norm)

    # fights
    res["fight_id"] = res["URL"].str.rsplit("/", n=1).str[-1]
    res = res.merge(ev[["EVENT", "event_id", "date"]], on="EVENT", how="left")
    ab = res["BOUT"].str.split(r"\s+vs\.\s+", n=1, expand=True, regex=True)
    res["name_a"], res["name_b"] = ab[0].str.strip(), ab[1].str.strip()
    oc = res["OUTCOME"].str.split("/", expand=True)
    res["out_a"], res["out_b"] = oc[0], oc[1]
    wc = res["WEIGHTCLASS"].map(clean.parse_weight_class)
    res["weight_class"] = wc.str[0]
    res["gender"] = wc.str[1]
    res["is_title"] = wc.str[2]
    res["is_catch"] = wc.str[3]
    res["method"] = res["METHOD"].map(clean.method_bucket)
    res["end_round"] = pd.to_numeric(res["ROUND"], errors="coerce")
    res["end_clock_s"] = res["TIME"].map(clean.mmss)
    res["round_lengths"] = res["TIME FORMAT"].map(clean.parse_format)
    res["scheduled_rounds"] = res["round_lengths"].map(len)
    res["end_time_s"] = [
        (sum(rl[: int(r) - 1]) + t) if np.isfinite(r) and np.isfinite(t) else np.nan
        for rl, r, t in zip(res["round_lengths"], res["end_round"], res["end_clock_s"])]
    res["std_format"] = res["round_lengths"].map(lambda rl: all(x == 300 for x in rl) and len(rl) in (3, 5))
    res["result_type"] = np.select(
        [res["out_a"].isin(["W", "L"]) & (res["method"] != "OVERTURNED"), res["out_a"] == "D"],
        ["WIN", "DRAW"], "NC")

    # fighter ids from names (dataset only carries names in results/stats). Duplicate names are
    # disambiguated by listed weight closest to the bout's division and flagged in data_quality.
    name_to_ids = fighters.groupby("name_norm")["fighter_id"].apply(list).to_dict()
    fw = fighters.set_index("fighter_id")["weight_lbs"].to_dict()
    dup_log = []

    def fid_for(nm, wclass):
        ids = name_to_ids.get(norm(nm), [])
        if len(ids) == 1:
            return ids[0]
        if not ids:
            return None
        target = clean.WEIGHT_CLASSES.get(wclass, 170)
        best = min(ids, key=lambda i: abs((fw.get(i) or 999) - target))
        dup_log.append(nm)
        return best

    res["fighter_a_id"] = [fid_for(n, w) for n, w in zip(res["name_a"], res["weight_class"])]
    res["fighter_b_id"] = [fid_for(n, w) for n, w in zip(res["name_b"], res["weight_class"])]
    res["winner_id"] = np.where(res["result_type"] == "WIN",
                                np.where(res["out_a"] == "W", res["fighter_a_id"], res["fighter_b_id"]), None)
    res["referee"] = res["REFEREE"]
    res["method_detail"] = res["DETAILS"]
    fights = res[["fight_id", "event_id", "date", "weight_class", "gender", "is_title", "is_catch",
                  "scheduled_rounds", "std_format", "fighter_a_id", "fighter_b_id", "name_a", "name_b",
                  "winner_id", "result_type", "method", "method_detail", "end_round", "end_clock_s",
                  "end_time_s", "referee", "EVENT", "BOUT"]].copy()
    fights = fights.drop_duplicates("fight_id")

    # rounds
    st = st[st["ROUND"].astype(str).str.startswith("Round")].copy()
    st["round"] = st["ROUND"].str.extract(r"(\d+)").astype(float)
    key = fights[["EVENT", "BOUT", "fight_id", "fighter_a_id", "fighter_b_id", "name_a", "name_b",
                  "end_round", "end_clock_s"]]
    st = st.merge(key, on=["EVENT", "BOUT"], how="inner")
    st["is_a"] = st["FIGHTER"].map(norm) == st["name_a"].map(norm)
    st["fighter_id"] = np.where(st["is_a"], st["fighter_a_id"], st["fighter_b_id"])
    st["opponent_id"] = np.where(st["is_a"], st["fighter_b_id"], st["fighter_a_id"])
    out = pd.DataFrame({"fight_id": st["fight_id"], "round": st["round"].astype(int),
                        "fighter_id": st["fighter_id"], "opponent_id": st["opponent_id"]})
    out["kd"] = pd.to_numeric(st["KD"], errors="coerce")
    for col, pre in [("SIG.STR.", "sig"), ("TOTAL STR.", "total"), ("TD", "td"), ("HEAD", "head"),
                     ("BODY", "body"), ("LEG", "leg"), ("DISTANCE", "dist"), ("CLINCH", "clinch"),
                     ("GROUND", "ground")]:
        pr = st[col].map(clean.of_pair)
        out[f"{pre}_l"] = pr.str[0].values
        out[f"{pre}_a"] = pr.str[1].values
    out["sub_att"] = pd.to_numeric(st["SUB.ATT"], errors="coerce").values
    out["rev"] = pd.to_numeric(st["REV."], errors="coerce").values
    out["ctrl_s"] = st["CTRL"].map(clean.mmss).values
    out["round_time_s"] = np.where(st["round"].values < st["end_round"].values, 300.0,
                                   np.where(st["round"].values == st["end_round"].values, st["end_clock_s"].values, np.nan))
    fight_rounds = out.drop_duplicates(["fight_id", "round", "fighter_id"])

    num = [c for c in fight_rounds.columns if c not in ("fight_id", "round", "fighter_id", "opponent_id", "round_time_s")]
    fr2 = fight_rounds.assign(rounds_with_stats=1)
    ff = fr2.groupby(["fight_id", "fighter_id", "opponent_id"], as_index=False, dropna=False)[
        num + ["rounds_with_stats"]].sum(min_count=1)

    tables = {"events": events, "fighters": fighters, "fights": fights, "fight_rounds": fight_rounds,
              "fighter_fight": ff}
    for n, t in tables.items():
        t.to_parquet(proc / f"{n}.parquet", index=False)
    stamp_file.write_text(stamp)
    (proc / "_dup_names.txt").write_text("\n".join(sorted(set(dup_log))))
    log.info("built tables: %s", {n: len(t) for n, t in tables.items()})
    return tables
