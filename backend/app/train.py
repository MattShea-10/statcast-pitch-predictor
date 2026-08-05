"""
Trains the next-pitch models:
  1. pitch_type classifier (which pitch comes next)
  2. zone classifier (where it's located)

Run after app/data_pull.py has produced data/statcast_raw.parquet.

Usage:
    python -m app.train
"""
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, top_k_accuracy_score

from app.features import (
    clean_and_engineer, build_pitcher_profiles, build_batter_profiles,
    make_feature_row, feature_columns,
)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

RAW_PATH = DATA_DIR / "statcast_raw.parquet"


def main():
    print("Loading raw statcast data...")
    df = pd.read_parquet(RAW_PATH)
    df = clean_and_engineer(df)
    print(f"{len(df):,} usable pitches after cleaning.")

    # Split by pitch BEFORE building profiles would leak test info back into
    # itself, but since pitcher/batter tendency profiles are meant to
    # represent "known season-long tendency" (not just this at-bat), we
    # build them on the full season and evaluate on a held-out random split
    # of individual pitches -- this mirrors how the deployed app will
    # actually be used (profiles are season-to-date, prediction is for the
    # next unseen pitch).
    train_df, test_df = train_test_split(df, test_size=0.15, random_state=42)

    print("Building pitcher tendency profiles...")
    pitcher_bundle = build_pitcher_profiles(df)
    print("Building batter tendency profiles...")
    batter_bundle = build_batter_profiles(df)

    pitch_labels = pitcher_bundle["pitch_labels"]
    zone_labels = pitcher_bundle["zone_labels"]
    feat_cols = feature_columns(pitch_labels, zone_labels)

    def rows_to_features(rows_df: pd.DataFrame) -> pd.DataFrame:
        feats = []
        for r in rows_df.itertuples():
            situation = {
                "balls": r.balls, "strikes": r.strikes,
                "outs_when_up": r.outs_when_up, "inning": r.inning,
                "is_top_inning": r.is_top_inning, "on_1b": r.on_1b,
                "on_2b": r.on_2b, "on_3b": r.on_3b,
                "score_diff": r.score_diff, "stand_R": r.stand_R,
                "throws_R": r.throws_R,
            }
            pp = pitcher_bundle["profiles"][int(r.pitcher)]
            bp = batter_bundle["profiles"][int(r.batter)]
            feats.append(make_feature_row(situation, pp, bp, int(r.batter), pitch_labels, zone_labels))
        return pd.DataFrame(feats, columns=feat_cols)

    print(f"Building feature matrix for {len(train_df):,} training rows...")
    X_train = rows_to_features(train_df)
    y_pitch_train = train_df["pitch_type"].values
    y_zone_train = train_df["zone"].values

    print(f"Building feature matrix for {len(test_df):,} test rows...")
    X_test = rows_to_features(test_df)
    y_pitch_test = test_df["pitch_type"].values
    y_zone_test = test_df["zone"].values

    print("Training pitch-type model...")
    # NOTE: no class_weight="balanced_subsample" here. That option reweights
    # each pitch type to have EQUAL influence during training regardless of
    # how often it's actually thrown -- great for rare-event detection, but
    # wrong for "what's this pitcher most likely to throw," since it
    # systematically inflates rarely-thrown pitches (e.g. a curveball thrown
    # 5% of the time ranking as the #1 prediction over a fastball thrown
    # 40% of the time). Leaving class_weight at its default keeps
    # predictions anchored to real usage frequency. Slightly shallower
    # trees + a higher min_samples_leaf also curb overfitting to specific
    # rare pitcher/batter/situation combinations.
    # n_estimators=50, max_depth=7 (down from 300/10): 120 trees at depth 10
    # still OOM'd on the deployed 512MB instance even with mmap-loading, so
    # this cuts much harder -- fewer, shallower trees means a smaller object
    # graph in memory regardless of how it's loaded. This trades more
    # accuracy than the first cut did; if predictions feel noticeably
    # worse, the fix is more RAM (a paid Render plan), not more trees.
    pitch_model = RandomForestClassifier(
        n_estimators=50, max_depth=7, min_samples_leaf=20,
        n_jobs=-1, random_state=42,
    )
    pitch_model.fit(X_train, y_pitch_train)
    pitch_pred = pitch_model.predict(X_test)
    pitch_proba = pitch_model.predict_proba(X_test)
    acc = accuracy_score(y_pitch_test, pitch_pred)
    try:
        top3 = top_k_accuracy_score(y_pitch_test, pitch_proba, k=3, labels=pitch_model.classes_)
    except Exception:
        top3 = float("nan")
    print(f"Pitch-type model: top-1 acc={acc:.3f}, top-3 acc={top3:.3f}")

    print("Training zone model...")
    # Same reasoning as the pitch-type model: no class_weight, so the 4
    # broad out-of-zone buckets don't get further inflated beyond the area
    # effect already discussed, and the 9 small in-zone cells aren't
    # artificially boosted to "match" them either.
    zone_model = RandomForestClassifier(
        n_estimators=50, max_depth=7, min_samples_leaf=20,
        n_jobs=-1, random_state=42,
    )
    zone_model.fit(X_train, y_zone_train)
    zone_pred = zone_model.predict(X_test)
    zone_acc = accuracy_score(y_zone_test, zone_pred)
    print(f"Zone model: top-1 acc={zone_acc:.3f} (13-class problem, random baseline ~0.08)")

    print("Saving model artifacts...")
    joblib.dump(pitch_model, MODEL_DIR / "pitch_type_model.joblib")
    joblib.dump(zone_model, MODEL_DIR / "zone_model.joblib")
    joblib.dump({
        "pitcher_profiles": pitcher_bundle["profiles"],
        "batter_profiles": batter_bundle["profiles"],
        "pitch_labels": pitch_labels,
        "zone_labels": zone_labels,
        "feature_columns": feat_cols,
        "metrics": {"pitch_top1": acc, "pitch_top3": top3, "zone_top1": zone_acc},
    }, MODEL_DIR / "artifacts.joblib")

    print(f"Done. Artifacts saved to {MODEL_DIR}")


if __name__ == "__main__":
    sys.exit(main())
