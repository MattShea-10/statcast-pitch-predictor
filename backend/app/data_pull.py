"""
Pulls Statcast pitch-by-pitch data for the current MLB season using pybaseball
(which scrapes Baseball Savant), keeps the columns we need, and builds a
player lookup table (id -> name, handedness).

Run this on your own machine (NOT inside a network-restricted sandbox) --
Baseball Savant needs to be reachable.

Usage:
    python -m app.data_pull                       # pulls 2026-03-01 .. today
    python -m app.data_pull --start 2026-04-01 --end 2026-07-27
"""
import argparse
import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

RAW_PATH = DATA_DIR / "statcast_raw.parquet"
PLAYERS_PATH = DATA_DIR / "players.parquet"

# Columns we actually need for the model + display. Statcast returns 90+
# columns; trimming keeps the parquet small and training fast.
KEEP_COLS = [
    "game_date", "pitcher", "batter", "pitch_type", "zone",
    "balls", "strikes", "outs_when_up", "inning", "inning_topbot",
    "on_1b", "on_2b", "on_3b", "bat_score", "fld_score",
    "stand", "p_throws", "player_name", "home_team", "away_team",
    "release_speed", "at_bat_number", "events",
]


def pull_season(start_dt: str, end_dt: str) -> pd.DataFrame:
    import pybaseball as pb
    pb.cache.enable()

    print(f"Pulling Statcast data {start_dt} -> {end_dt} (this can take a while)...")
    df = pb.statcast(start_dt=start_dt, end_dt=end_dt)
    if df is None or df.empty:
        raise RuntimeError("pybaseball.statcast() returned no rows -- check the date range.")

    missing = [c for c in KEEP_COLS if c not in df.columns]
    if missing:
        print(f"Warning: missing expected columns {missing}, continuing without them.")
    cols = [c for c in KEEP_COLS if c in df.columns]
    df = df[cols].copy()

    # Drop rows with no pitch type or zone -- these are unusable for training.
    df = df.dropna(subset=["pitch_type", "zone", "pitcher", "batter"])
    df["zone"] = df["zone"].astype(int)
    df["pitcher"] = df["pitcher"].astype(int)
    df["batter"] = df["batter"].astype(int)
    if "game_date" in df.columns:
        df["game_date"] = pd.to_datetime(df["game_date"])

    return df


def build_player_table(df: pd.DataFrame) -> pd.DataFrame:
    """Build id -> name/handedness lookup for both pitchers and batters."""
    import pybaseball as pb

    pitcher_ids = df["pitcher"].unique().tolist()
    batter_ids = df["batter"].unique().tolist()
    all_ids = sorted(set(pitcher_ids) | set(batter_ids))

    print(f"Looking up names for {len(all_ids)} unique players...")
    lookup = pb.playerid_reverse_lookup(all_ids, key_type="mlbam")
    lookup["mlbam"] = lookup["key_mlbam"].astype(int)
    lookup["name"] = (lookup["name_first"].str.title() + " " + lookup["name_last"].str.title())
    id_to_name = dict(zip(lookup["mlbam"], lookup["name"]))

    # Pitcher handedness comes straight from p_throws; batter handedness from stand.
    pitcher_throws = df.groupby("pitcher")["p_throws"].agg(lambda s: s.mode().iat[0])
    batter_stands = df.groupby("batter")["stand"].agg(lambda s: s.mode().iat[0])

    # Switch hitters bat from both sides depending on the pitcher's
    # handedness. Flag anyone with a meaningful sample of plate appearances
    # from BOTH sides (not just a stray data glitch) so the UI can offer a
    # left/right choice instead of assuming their single most common side.
    SWITCH_HITTER_MIN_PITCHES = 20
    switch_hitter_map = {}
    stand_counts = df.groupby(["batter", "stand"]).size().unstack(fill_value=0)
    for bid in batter_ids:
        if bid in stand_counts.index:
            l_count = stand_counts.loc[bid].get("L", 0)
            r_count = stand_counts.loc[bid].get("R", 0)
            switch_hitter_map[bid] = bool(l_count >= SWITCH_HITTER_MIN_PITCHES and r_count >= SWITCH_HITTER_MIN_PITCHES)
        else:
            switch_hitter_map[bid] = False

    # Current team (handles in-season trades by taking each player's most
    # recent appearance): pitcher's team is the fielding team, i.e. home_team
    # during the top of an inning (visitors bat) and away_team in the bottom.
    pitcher_team_map, batter_team_map, lineup_slot_map = {}, {}, {}
    if "home_team" in df.columns and "away_team" in df.columns and "game_date" in df.columns:
        is_top = df["inning_topbot"].astype(str).str.lower() == "top"
        df = df.assign(
            pitcher_team=np.where(is_top, df["home_team"], df["away_team"]),
            batter_team=np.where(is_top, df["away_team"], df["home_team"]),
        )
        latest_p = df.sort_values("game_date").groupby("pitcher").tail(1)
        pitcher_team_map = dict(zip(latest_p["pitcher"], latest_p["pitcher_team"]))
        latest_b = df.sort_values("game_date").groupby("batter").tail(1)
        batter_team_map = dict(zip(latest_b["batter"], latest_b["batter_team"]))

        # Batting-order slot from each batter's most recent game: rank each
        # batter by the first at_bat_number they appeared at that game,
        # among their own team that day (1 = leadoff, 2 = second, ...). This
        # lets the UI list a team's batters in actual last-game lineup order
        # instead of alphabetically.
        lineup_slot_map = {}
        if "at_bat_number" in df.columns:
            first_ab = (
                df.groupby(["game_date", "batter_team", "batter"])["at_bat_number"]
                .min()
                .reset_index()
            )
            first_ab["lineup_slot"] = (
                first_ab.groupby(["game_date", "batter_team"])["at_bat_number"]
                .rank(method="first")
                .astype(int)
            )
            latest_game_map = dict(zip(latest_b["batter"], latest_b["game_date"]))
            slot_lookup = {
                (r.batter, r.game_date): r.lineup_slot for r in first_ab.itertuples()
            }
            for bid in batter_ids:
                lineup_slot_map[bid] = slot_lookup.get((bid, latest_game_map.get(bid)))

    rows = []
    for pid in pitcher_ids:
        rows.append({
            "id": int(pid),
            "name": id_to_name.get(pid, f"Pitcher {pid}"),
            "role": "pitcher",
            "throws": pitcher_throws.get(pid, "R"),
            "team": pitcher_team_map.get(pid, ""),
        })
    for bid in batter_ids:
        slot = lineup_slot_map.get(bid)
        rows.append({
            "id": int(bid),
            "name": id_to_name.get(bid, f"Batter {bid}"),
            "role": "batter",
            "stand": batter_stands.get(bid, "R"),
            "switch_hitter": switch_hitter_map.get(bid, False),
            "team": batter_team_map.get(bid, ""),
            "last_lineup_slot": int(slot) if slot is not None else None,
        })
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    default_start = f"{date.today().year}-03-01"
    default_end = date.today().isoformat()
    parser.add_argument("--start", default=default_start)
    parser.add_argument("--end", default=default_end)
    args = parser.parse_args()

    df = pull_season(args.start, args.end)
    print(f"Pulled {len(df):,} pitches.")

    players = build_player_table(df)
    print(f"Built player table with {len(players):,} rows "
          f"({(players.role == 'pitcher').sum()} pitchers, "
          f"{(players.role == 'batter').sum()} batters).")

    df.to_parquet(RAW_PATH, index=False)
    players.to_parquet(PLAYERS_PATH, index=False)
    print(f"Saved: {RAW_PATH}\nSaved: {PLAYERS_PATH}")


if __name__ == "__main__":
    sys.exit(main())
