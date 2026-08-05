"""
FastAPI backend for the Statcast next-pitch predictor.

Endpoints:
  GET  /api/players?role=pitcher|batter&q=search&team=NYY  -> list of players for the dropdowns
  GET  /api/teams?role=pitcher|batter                        -> distinct team abbreviations
  GET  /api/health                                           -> model status / metrics
  POST /api/predict                                          -> next-pitch prediction
  POST /api/verify_predictions                                -> check tracked predictions against real data

Run:
    uvicorn app.main:app --reload --port 8000
"""
from pathlib import Path
from typing import List, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.features import (
    PITCH_TYPE_ALIASES, PITCH_TYPE_NAMES, ZONE_LABELS, make_feature_row, pitcher_count_dist,
    pitcher_runners_dist, pitcher_zone_for_pitch_count, pitcher_velo_for_pitch,
    pitcher_vs_batter_pitch, pitcher_vs_batter_zone, batter_hit_rate_for_zone,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MODEL_DIR = Path(__file__).resolve().parent.parent / "models"

app = FastAPI(title="Statcast Next-Pitch Predictor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_state = {"loaded": False}


def load_artifacts():
    players_path = DATA_DIR / "players.parquet"
    artifacts_path = MODEL_DIR / "artifacts.joblib"
    pitch_model_path = MODEL_DIR / "pitch_type_model.joblib"
    zone_model_path = MODEL_DIR / "zone_model.joblib"

    missing = [p for p in [players_path, artifacts_path, pitch_model_path, zone_model_path] if not p.exists()]
    if missing:
        _state["loaded"] = False
        _state["missing"] = [str(p) for p in missing]
        return

    _state["players"] = pd.read_parquet(players_path)
    artifacts = joblib.load(artifacts_path)
    _state["pitcher_profiles"] = artifacts["pitcher_profiles"]
    _state["batter_profiles"] = artifacts["batter_profiles"]
    _state["pitch_labels"] = artifacts["pitch_labels"]
    _state["zone_labels"] = artifacts["zone_labels"]
    _state["feature_columns"] = artifacts["feature_columns"]
    _state["metrics"] = artifacts["metrics"]
    # mmap_mode="r": the pitch/zone models are RandomForests whose bulk is
    # plain numpy arrays (tree node arrays). Memory-mapping instead of fully
    # loading into RAM lets the OS page those arrays in on demand and share/
    # evict them, which is the difference between fitting in Render's 512MB
    # free-tier instance and OOMing on startup. Requires the .joblib files to
    # be uncompressed (train.py's joblib.dump calls already are, by default).
    _state["pitch_model"] = joblib.load(pitch_model_path, mmap_mode="r")
    _state["zone_model"] = joblib.load(zone_model_path, mmap_mode="r")
    _state["loaded"] = True


@app.on_event("startup")
def _startup():
    load_artifacts()


class Situation(BaseModel):
    pitcher_id: int
    batter_id: int
    inning: int = Field(ge=1, le=20)
    is_top_inning: bool = True
    balls: int = Field(ge=0, le=3)
    strikes: int = Field(ge=0, le=2)
    outs_when_up: int = Field(ge=0, le=2)
    on_1b: bool = False
    on_2b: bool = False
    on_3b: bool = False
    bat_score: int = 0
    fld_score: int = 0
    # Optional override for switch hitters, who bat from either side
    # depending on the pitcher's handedness. "L" or "R"; falls back to the
    # batter's most common recorded stance if omitted.
    batter_stand: Optional[str] = Field(default=None, pattern="^[LR]$")


class TrackedPrediction(BaseModel):
    """A single prediction the frontend logged at 'Predict Next Pitch' time,
    plus enough of the exact real-world situation (which game/date, count,
    outs, runners, inning) to look up what actually got thrown once fresher
    data has been pulled -- e.g. the next morning."""
    date: str  # YYYY-MM-DD, the date of the game being watched when this was predicted
    pitcher_id: int
    batter_id: int
    inning: int
    is_top_inning: bool = True
    balls: int
    strikes: int
    outs_when_up: int
    on_1b: bool = False
    on_2b: bool = False
    on_3b: bool = False
    predicted_pitch_code: str
    predicted_zone: int


class VerifyRequest(BaseModel):
    predictions: List[TrackedPrediction]


@app.get("/api/health")
def health():
    if not _state.get("loaded"):
        return {"status": "not_ready", "missing_files": _state.get("missing", [])}
    return {"status": "ready", "metrics": _state["metrics"], "n_players": len(_state["players"])}


@app.get("/api/teams")
def teams(role: Optional[str] = Query(None, pattern="^(pitcher|batter)$")):
    if not _state.get("loaded"):
        raise HTTPException(503, "Model not trained yet. Run data_pull.py and train.py first.")
    df = _state["players"]
    if role:
        df = df[df["role"] == role]
    if "team" not in df.columns:
        return []
    team_list = sorted(t for t in df["team"].dropna().unique().tolist() if t)
    return team_list


@app.get("/api/players")
def players(
    role: str = Query(..., pattern="^(pitcher|batter)$"),
    q: Optional[str] = None,
    team: Optional[str] = None,
    limit: int = 50,
):
    if not _state.get("loaded"):
        raise HTTPException(503, "Model not trained yet. Run data_pull.py and train.py first.")
    df = _state["players"]
    df = df[df["role"] == role]
    if team and "team" in df.columns:
        df = df[df["team"] == team]
    if q:
        df = df[df["name"].str.contains(q, case=False, na=False)]
    # When browsing a whole team's roster, show everyone rather than
    # truncating to the default page size.
    effective_limit = limit if not team else max(limit, 200)
    # Batters: order by their last game's actual batting order (leadoff
    # first, etc.) instead of alphabetically, so a team's lineup reads the
    # way it was actually run out last game. Anyone without a known slot
    # (e.g. didn't appear in that most recent game) sorts to the end, by name.
    if role == "batter" and "last_lineup_slot" in df.columns:
        df = df.sort_values(["last_lineup_slot", "name"], na_position="last")
    else:
        df = df.sort_values("name")
    df = df.head(effective_limit)
    cols = ["id", "name"] + (["throws"] if role == "pitcher" else ["stand"])
    if role == "batter" and "switch_hitter" in df.columns:
        cols.append("switch_hitter")
    if role == "batter" and "last_lineup_slot" in df.columns:
        cols.append("last_lineup_slot")
    if "team" in df.columns:
        cols.append("team")

    records = df[cols].to_dict(orient="records")
    # pandas represents missing lineup slots as NaN (float), which isn't
    # valid JSON -- normalize to a proper int or null.
    if role == "batter" and "last_lineup_slot" in cols:
        for r in records:
            slot = r.get("last_lineup_slot")
            r["last_lineup_slot"] = int(slot) if pd.notna(slot) else None
    return records


@app.post("/api/predict")
def predict(situation: Situation):
    if not _state.get("loaded"):
        raise HTTPException(503, "Model not trained yet. Run data_pull.py and train.py first.")

    pitcher_profiles = _state["pitcher_profiles"]
    batter_profiles = _state["batter_profiles"]
    pitch_labels = _state["pitch_labels"]
    zone_labels = _state["zone_labels"]
    feat_cols = _state["feature_columns"]

    pp = pitcher_profiles.get(situation.pitcher_id)
    bp = batter_profiles.get(situation.batter_id)
    if pp is None:
        raise HTTPException(404, f"Pitcher id {situation.pitcher_id} not found in training data.")
    if bp is None:
        raise HTTPException(404, f"Batter id {situation.batter_id} not found in training data.")

    throws_R = 1 if pp["throws"] == "R" else 0
    effective_stand = situation.batter_stand or bp["stand"]
    stand_R = 1 if effective_stand == "R" else 0
    score_diff = max(-10, min(10, situation.bat_score - situation.fld_score))

    sit = {
        "balls": situation.balls, "strikes": situation.strikes,
        "outs_when_up": situation.outs_when_up, "inning": situation.inning,
        "is_top_inning": int(situation.is_top_inning),
        "on_1b": int(situation.on_1b), "on_2b": int(situation.on_2b), "on_3b": int(situation.on_3b),
        "score_diff": score_diff, "stand_R": stand_R, "throws_R": throws_R,
    }

    row = make_feature_row(sit, pp, bp, situation.batter_id, pitch_labels, zone_labels)
    X = pd.DataFrame([row], columns=feat_cols)

    pitch_model = _state["pitch_model"]
    zone_model = _state["zone_model"]

    raw_pitch_proba = pitch_model.predict_proba(X)[0]
    raw_zone_proba = zone_model.predict_proba(X)[0]

    count_pitch_dist = pitcher_count_dist(pp, "pitch", situation.balls, situation.strikes)
    count_zone_dist = pitcher_count_dist(pp, "zone", situation.balls, situation.strikes)

    # This pitcher's real tendency conditioned on who's actually on base
    # right now (e.g. more fastballs with a runner on 1st to help the
    # catcher control the running game) -- independent of the count-based
    # signal above, so a full-count, bases-loaded situation reflects both.
    runners_pitch_dist = pitcher_runners_dist(
        pp, "pitch", situation.on_1b, situation.on_2b, situation.on_3b)
    runners_zone_dist = pitcher_runners_dist(
        pp, "zone", situation.on_1b, situation.on_2b, situation.on_3b)

    # Combine count-based and runners-based situational tendency (simple
    # average of the two) into one "what's this pitcher's real tendency
    # right now" baseline, before layering the batter-matchup adjustment on
    # top of it below.
    situational_pitch_dist = {
        c: 0.5 * count_pitch_dist.get(c, 0.0) + 0.5 * runners_pitch_dist.get(c, 0.0)
        for c in pitch_model.classes_
    }
    situational_zone_dist = {
        int(z): 0.5 * count_zone_dist.get(int(z), 0.0) + 0.5 * runners_zone_dist.get(int(z), 0.0)
        for z in zone_model.classes_
    }

    # What has this SPECIFIC pitcher actually thrown/located against this
    # SPECIFIC batter, shrunk toward the combined situational tendency above
    # -- this is the matchup-aware empirical anchor (falls back to the
    # generic count+runners tendency for a brand-new matchup, but leans
    # toward real history once there's any).
    matchup_pitch_dist = pitcher_vs_batter_pitch(pp, situation.batter_id, situational_pitch_dist)
    matchup_zone_dist = pitcher_vs_batter_zone(pp, situation.batter_id, situational_zone_dist)

    # Blend the classifier's output with that matchup-aware empirical
    # tendency. Verified directly against real data: the raw RandomForest
    # itself will sometimes rank a pitch a specific pitcher rarely throws
    # above his actual primary pitch (e.g. predicting a fastball-heavy
    # approach for a pitcher whose real mix is majority splitter) -- most
    # starters lean fastball-heavy, so that pattern dominates the trees and
    # can leak into pitchers who don't fit it. The empirical tendency below
    # is directly computed from what this pitcher has actually thrown, so
    # weighting it heavily anchors the final prediction to reality instead
    # of letting the model's imperfect generalization override real usage.
    MODEL_WEIGHT = 0.35
    EMPIRICAL_WEIGHT = 1 - MODEL_WEIGHT

    pitch_proba = MODEL_WEIGHT * raw_pitch_proba + EMPIRICAL_WEIGHT * np.array(
        [matchup_pitch_dist.get(c, 0.0) for c in pitch_model.classes_]
    )
    zone_proba = MODEL_WEIGHT * raw_zone_proba + EMPIRICAL_WEIGHT * np.array(
        [matchup_zone_dist.get(int(z), 0.0) for z in zone_model.classes_]
    )

    # Nudge location away from wherever THIS batter has actually done damage
    # this season, and toward wherever he's been weak -- a real, basic
    # pitching heuristic ("don't throw it where he hits it"). This is a
    # DENSE, batter-level signal (pooled across every pitcher he's faced),
    # unlike the pair-specific matchup_zone_dist above, which is almost
    # always too sparse (most pitcher/batter pairs only share a handful of
    # pitches all season) to meaningfully shift a 13-way zone prediction on
    # its own. Applied as a bounded multiplicative factor (0.5x-1.5x) so it
    # nudges the distribution rather than overriding the pitcher's own real
    # tendency captured above.
    AVOIDANCE_STRENGTH = 2.0

    def _zone_avoidance_factors(zones) -> np.ndarray:
        overall_rate = bp.get("overall_hit_rate", 0.0)
        factors = np.array([
            1.0 - AVOIDANCE_STRENGTH * (batter_hit_rate_for_zone(bp, z) - overall_rate)
            for z in zones
        ])
        return np.clip(factors, 0.5, 1.5)

    def _apply_zone_avoidance(dist: dict) -> dict:
        zs = list(dist.keys())
        factors = _zone_avoidance_factors(zs)
        adjusted = {z: p * f for z, p, f in zip(zs, dist.values(), factors)}
        total = sum(adjusted.values())
        return {z: p / total for z, p in adjusted.items()} if total > 0 else dist

    zone_proba = zone_proba * _zone_avoidance_factors(zone_model.classes_)
    zone_total = zone_proba.sum()
    if zone_total > 0:
        zone_proba = zone_proba / zone_total

    # Not every pitcher throws every pitch type -- the classifier still
    # assigns a sliver of probability to pitches this specific pitcher has
    # NEVER thrown all season (RandomForest leaves can generalize across
    # pitchers), which cluttered the list with ~0-2% "ghost" entries that
    # never meaningfully changed and made the whole list look static. Drop
    # any pitch type that isn't actually in this pitcher's real arsenal
    # (i.e. they've thrown it at least once) and renormalize so the
    # remaining, real probabilities still sum to 100%.
    arsenal = {c for c in pitch_model.classes_ if pp["overall_pitch"].get(c, 0.0) > 0}
    if not arsenal:
        arsenal = set(pitch_model.classes_)  # defensive fallback, shouldn't happen

    arsenal_mask = np.array([c in arsenal for c in pitch_model.classes_])
    arsenal_proba = pitch_proba * arsenal_mask
    total = arsenal_proba.sum()
    if total > 0:
        arsenal_proba = arsenal_proba / total

    pitch_results = sorted(
        [{"code": c, "name": PITCH_TYPE_NAMES.get(c, c), "probability": float(p),
          "avg_mph": pitcher_velo_for_pitch(pp, c)}
         for c, p in zip(pitch_model.classes_, arsenal_proba) if c in arsenal],
        key=lambda r: -r["probability"],
    )
    zone_results = sorted(
        [{"zone": int(z), "label": ZONE_LABELS.get(int(z), str(z)), "probability": float(p)}
         for z, p in zip(zone_model.classes_, zone_proba)],
        key=lambda r: -r["probability"],
    )

    pitcher_tendency = sorted(
        [{"code": c, "name": PITCH_TYPE_NAMES.get(c, c), "probability": float(p)}
         for c, p in count_pitch_dist.items() if c in arsenal],
        key=lambda r: -r["probability"],
    )[:5]

    # Location conditioned on each specific pitch type AND the current count
    # (e.g. "if this is a slider on 3-2, where does it tend to go" differs
    # from "...on 1-1"). Blended with this pitcher's runners-on-base zone
    # tendency (weighted less heavily -- 0.3 -- since it isn't pitch-specific
    # the way the count breakdown is, just a real overall shift like "keeps
    # it lower with a runner on 1st"), then the batter avoidance adjustment.
    # Only built for pitches actually in this pitcher's arsenal -- no point
    # showing a location breakdown for a pitch he doesn't throw.
    zone_by_pitch = {}
    for code in pitch_model.classes_:
        if code not in arsenal:
            continue
        pitch_count_dist = pitcher_zone_for_pitch_count(pp, code, situation.balls, situation.strikes)
        dist = {
            z: 0.7 * pitch_count_dist.get(z, 0.0) + 0.3 * runners_zone_dist.get(z, 0.0)
            for z in pitch_count_dist
        }
        total = sum(dist.values())
        if total > 0:
            dist = {z: p / total for z, p in dist.items()}
        dist = _apply_zone_avoidance(dist)
        zone_by_pitch[code] = sorted(
            [{"zone": int(z), "label": ZONE_LABELS.get(int(z), str(z)), "probability": float(p)}
             for z, p in dist.items()],
            key=lambda r: -r["probability"],
        )

    return {
        "pitch_type": pitch_results,
        "zone": zone_results,
        "zone_by_pitch": zone_by_pitch,
        "pitcher_count_tendency": pitcher_tendency,
        "pitcher_n_pitches": pp["n_pitches"],
        "batter_n_pitches": bp["n_pitches"],
        "pitcher_description": _pitcher_description(pp),
        "batter_description": _batter_description(bp),
    }


@app.post("/api/verify_predictions")
def verify_predictions(req: VerifyRequest):
    """Check a batch of previously-tracked predictions against the real
    pitches actually thrown -- meant to be called the day after (or later),
    once you've re-run data_pull.py and the game(s) you were watching have
    been processed into statcast_raw.parquet. Each tracked prediction is
    matched to a real row by pitcher, batter, exact game date, and the exact
    count/outs/runners/inning combo it was made at. This match isn't
    perfectly unique (the same situational combo could recur within a game),
    so the first matching real pitch is used."""
    raw_path = DATA_DIR / "statcast_raw.parquet"
    if not raw_path.exists():
        raise HTTPException(503, "No raw Statcast data on disk to verify against.")

    df = pd.read_parquet(raw_path)
    required = {"pitcher", "batter", "game_date", "balls", "strikes", "outs_when_up",
                "inning", "inning_topbot", "on_1b", "on_2b", "on_3b", "pitch_type", "zone"}
    missing = required - set(df.columns)
    if missing:
        raise HTTPException(503, f"Raw data is missing columns needed to verify: {sorted(missing)}")

    df = df.dropna(subset=["pitch_type", "zone", "pitcher", "batter"]).copy()
    df["pitch_type_norm"] = df["pitch_type"].map(lambda p: PITCH_TYPE_ALIASES.get(p, p))
    df["zone"] = df["zone"].astype(int)
    df["game_date_str"] = pd.to_datetime(df["game_date"]).dt.strftime("%Y-%m-%d")
    df["is_top"] = df["inning_topbot"].astype(str).str.lower() == "top"
    df["r1"] = df["on_1b"].notna()
    df["r2"] = df["on_2b"].notna()
    df["r3"] = df["on_3b"].notna()

    results = []
    for tp in req.predictions:
        match = df[
            (df["pitcher"] == tp.pitcher_id)
            & (df["batter"] == tp.batter_id)
            & (df["game_date_str"] == tp.date)
            & (df["balls"] == tp.balls)
            & (df["strikes"] == tp.strikes)
            & (df["outs_when_up"] == tp.outs_when_up)
            & (df["inning"] == tp.inning)
            & (df["is_top"] == tp.is_top_inning)
            & (df["r1"] == tp.on_1b)
            & (df["r2"] == tp.on_2b)
            & (df["r3"] == tp.on_3b)
        ]
        entry = tp.model_dump()
        if match.empty:
            entry["found"] = False
        else:
            row = match.iloc[0]
            actual_pitch = row["pitch_type_norm"]
            actual_zone = int(row["zone"])
            entry.update({
                "found": True,
                "actual_pitch_code": actual_pitch,
                "actual_pitch_name": PITCH_TYPE_NAMES.get(actual_pitch, actual_pitch),
                "actual_zone": actual_zone,
                "actual_zone_label": ZONE_LABELS.get(actual_zone, str(actual_zone)),
                "pitch_correct": actual_pitch == tp.predicted_pitch_code,
                "zone_correct": actual_zone == tp.predicted_zone,
            })
        results.append(entry)

    matched = [r for r in results if r["found"]]
    n = len(matched)
    pitch_accuracy = (sum(r["pitch_correct"] for r in matched) / n) if n else None
    zone_accuracy = (sum(r["zone_correct"] for r in matched) / n) if n else None

    return {
        "results": results,
        "n_tracked": len(req.predictions),
        "n_matched": n,
        "pitch_accuracy": pitch_accuracy,
        "zone_accuracy": zone_accuracy,
    }


def _pitcher_description(pp: dict) -> str:
    """One-line, real-data summary of a pitcher's arsenal -- e.g. 'Left-handed
    · 882 pitches in 2026 · leans on Sinker (44.9%) and Sweeper (37.2%)'."""
    throws = "Right-handed" if pp["throws"] == "R" else "Left-handed"
    top = sorted(
        [(c, p) for c, p in pp["overall_pitch"].items() if p > 0],
        key=lambda x: -x[1],
    )[:2]
    if not top:
        return f"{throws} · {pp['n_pitches']:,} pitches in 2026."
    names = " and ".join(f"{PITCH_TYPE_NAMES.get(c, c)} ({p * 100:.1f}%)" for c, p in top)
    return f"{throws} · {pp['n_pitches']:,} pitches in 2026 · leans on {names}."


def _batter_description(bp: dict) -> str:
    """One-line, real-data summary of a batter -- e.g. 'Bats left · 1,678
    pitches seen in 2026 · hits on 26.6% of decisive pitches, most dangerous
    Up-Away (48.2%)'."""
    stand = "Bats right" if bp["stand"] == "R" else "Bats left"
    base = f"{stand} · {bp['n_pitches']:,} pitches seen in 2026"
    hit_rate_by_zone = bp.get("hit_rate_by_zone", {})
    if not hit_rate_by_zone:
        return f"{base}."
    hot_zone, hot_rate = max(hit_rate_by_zone.items(), key=lambda x: x[1])
    overall = bp.get("overall_hit_rate", 0.0)
    return (
        f"{base} · hits on {overall * 100:.1f}% of decisive pitches, "
        f"most dangerous {ZONE_LABELS.get(hot_zone, hot_zone)} ({hot_rate * 100:.1f}%)."
    )
