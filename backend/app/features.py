"""
Shared feature engineering for the pitch predictor.

Design: the model doesn't feed raw pitcher/batter IDs into the classifier
(high-cardinality integers with no ordinal meaning are a poor fit for that).
Instead we pre-compute each pitcher's pitch-mix / zone-mix tendencies
(overall, and blended by ball-strike count with shrinkage toward the
overall rate so sparse counts don't overfit), plus each batter's "what
pitches do I tend to see" tendencies. Those rates become the model's
features alongside the raw situational context (inning, count, outs,
runners, score, handedness). A RandomForest then learns how situational
context nudges those baseline tendencies.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# Collapse rare/legacy pitch codes into the modern buckets Statcast uses.
PITCH_TYPE_ALIASES = {
    "FA": "FF", "SI": "SI", "FT": "SI", "FF": "FF", "FC": "FC",
    "SL": "SL", "ST": "ST", "SV": "SV", "CU": "CU", "KC": "KC",
    "CH": "CH", "FS": "FS", "FO": "FS", "SC": "CH", "KN": "KN",
    "EP": "CH", "PO": None, "IN": None, "UN": None,
}

PITCH_TYPE_NAMES = {
    "FF": "4-Seam Fastball", "SI": "Sinker", "FC": "Cutter",
    "SL": "Slider", "ST": "Sweeper", "SV": "Slurve",
    "CU": "Curveball", "KC": "Knuckle Curve", "CH": "Changeup",
    "FS": "Splitter", "KN": "Knuckleball",
}

# Statcast zone numbering: 1-9 is the strike zone in a 3x3 grid (catcher's
# view), 11/12/13/14 are the four out-of-zone quadrants.
ZONE_LABELS = {
    1: "Up-Away", 2: "Up-Middle", 3: "Up-In",
    4: "Middle-Away", 5: "Middle-Middle", 6: "Middle-In",
    7: "Down-Away", 8: "Down-Middle", 9: "Down-In",
    11: "Out Up-Away", 12: "Out Up-In", 13: "Out Down-Away", 14: "Out Down-In",
}
ALL_ZONES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14]

SITUATION_COLS = [
    "balls", "strikes", "outs_when_up", "inning", "is_top_inning",
    "on_1b", "on_2b", "on_3b", "score_diff", "stand_R", "throws_R",
]

SHRINKAGE_K = 8  # pseudo-count weight for blending count-specific rates toward overall

# Pitcher-vs-this-specific-batter pitch/zone mix gets shrunk toward the
# pitcher's count tendency with a LOWER pseudo-count than SHRINKAGE_K. Most
# pitcher/batter pairs only have a handful of career pitches between them
# (median ~6), so a high k would wash the matchup out to "whatever this
# pitcher generally throws" almost every time. A lower k lets real signal
# ("he's pitched THIS guy backwards, more offspeed than usual") show through
# once there are even a few pitches of history, while still falling back
# gracefully to the generic tendency for brand-new matchups.
MATCHUP_K = 5


def clean_and_engineer(df: pd.DataFrame) -> pd.DataFrame:
    """Take raw statcast rows and produce a model-ready dataframe."""
    df = df.copy()
    df["pitch_type"] = df["pitch_type"].map(lambda p: PITCH_TYPE_ALIASES.get(p, p))
    df = df.dropna(subset=["pitch_type", "zone"])
    df = df[df["pitch_type"].isin(PITCH_TYPE_NAMES.keys())]
    df["zone"] = df["zone"].astype(int)
    df = df[df["zone"].isin(ALL_ZONES)]

    df["is_top_inning"] = (df["inning_topbot"].astype(str).str.lower() == "top").astype(int)
    df["on_1b"] = df["on_1b"].notna().astype(int)
    df["on_2b"] = df["on_2b"].notna().astype(int)
    df["on_3b"] = df["on_3b"].notna().astype(int)
    df["score_diff"] = (df["bat_score"] - df["fld_score"]).clip(-10, 10)
    df["stand_R"] = (df["stand"] == "R").astype(int)
    df["throws_R"] = (df["p_throws"] == "R").astype(int)

    for c in ["balls", "strikes", "outs_when_up", "inning"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["balls", "strikes", "outs_when_up", "inning"])

    return df


def _shrunk_dist(group_counts, overall_dist: dict, k: float = SHRINKAGE_K) -> dict:
    """`group_counts` can be a pandas Series (e.g. from value_counts()) or a
    plain dict of label -> count -- both are normalized to dict access here
    so this works both when building profiles (Series) and when blending a
    raw stored counts dict at inference time (plain dict)."""
    if isinstance(group_counts, pd.Series):
        n = group_counts.sum()
        counts = group_counts
    else:
        counts = group_counts or {}
        n = sum(counts.values())
    out = {}
    for label, base_p in overall_dist.items():
        c = counts.get(label, 0) if hasattr(counts, "get") else 0
        out[label] = (c + k * base_p) / (n + k)
    return out


def _shrunk_rate(hits: float, attempts: float, overall_rate: float, k: float = SHRINKAGE_K) -> float:
    """Same shrinkage idea as _shrunk_dist, but for a single hit-rate-style
    stat (hits / decisive pitches of a given type) instead of a whole
    distribution -- blends toward the overall rate so a batter who's only
    seen a handful of, say, splitters doesn't get an overfit 100% or 0%."""
    return (hits + k * overall_rate) / (attempts + k)


# Pitch outcomes that count as a "hit" for the batter's hit-rate-by-pitch-type
# signal. Only pitches that ended the plate appearance (events not null) are
# counted at all, so this reads as "how often does this at-bat-ending pitch
# of this type go for a hit," not a true batting-average-on-balls-in-play.
HIT_EVENTS = {"single", "double", "triple", "home_run"}


def build_pitcher_profiles(df: pd.DataFrame) -> dict:
    """
    For each pitcher: overall pitch_type/zone distribution, plus a
    shrinkage-blended distribution per (balls, strikes) count.
    """
    profiles = {}
    pitch_labels = sorted(df["pitch_type"].unique())
    zone_labels = ALL_ZONES

    for pid, g in df.groupby("pitcher"):
        overall_pitch = (g["pitch_type"].value_counts(normalize=True)
                         .reindex(pitch_labels, fill_value=0.0).to_dict())
        overall_zone = (g["zone"].value_counts(normalize=True)
                        .reindex(zone_labels, fill_value=0.0).to_dict())

        by_count_pitch = {}
        by_count_zone = {}
        for (b, s), cg in g.groupby(["balls", "strikes"]):
            by_count_pitch[(int(b), int(s))] = _shrunk_dist(
                cg["pitch_type"].value_counts(), overall_pitch)
            by_count_zone[(int(b), int(s))] = _shrunk_dist(
                cg["zone"].value_counts(), overall_zone)

        # NOTE: this used to also store by_runners_pitch/by_runners_zone
        # (mix conditioned on exact runners-on-base combo) and
        # zone_by_pitch_count (zone mix conditioned on pitch type AND exact
        # count). Both were cut -- not because they're not useful, but
        # because their cardinality (runners combo, or pitch x count, per
        # pitcher) balloons into tens of thousands of small Python dicts
        # across ~1100 pitchers, which took the deployed artifacts blob from
        # ~27MB on disk to ~390MB of actual Python object memory once
        # loaded -- more than the 512MB Render gives the free-tier instance,
        # by itself, before the models or anything else even loaded. The
        # lookup functions (pitcher_runners_dist, pitcher_zone_for_pitch_count)
        # already fall back gracefully to a less granular tendency when
        # these keys are absent, so removing them degrades prediction
        # granularity slightly (runners-on-base and pitch+count-specific
        # location nuance) rather than breaking anything.

        # Where does THIS pitch type specifically tend to go for this
        # pitcher? (e.g. breaking balls down-and-away, fastballs up), shrunk
        # toward their overall zone mix so rarely-thrown pitches don't
        # overfit to a handful of pitches.
        zone_by_pitch = {}
        for pitch, pg in g.groupby("pitch_type"):
            zone_by_pitch[pitch] = _shrunk_dist(pg["zone"].value_counts(), overall_zone)

        # Average velocity for each pitch type this pitcher throws (e.g. "his
        # slider averages 84.2 mph"), so the UI can show a realistic speed
        # alongside the pitch name and probability.
        velo_by_pitch = {}
        if "release_speed" in g.columns:
            means = g.groupby("pitch_type")["release_speed"].mean()
            velo_by_pitch = {p: round(float(v), 1) for p, v in means.items() if pd.notna(v)}

        # Raw pitch/zone counts this pitcher has actually thrown to EACH
        # specific batter they've faced -- "what does THIS pitcher actually
        # choose to throw against THIS batter," not just a generic pitcher
        # tendency or a generic batter tendency. Stored as raw counts (not
        # pre-shrunk) so they can be blended toward whatever base
        # distribution is relevant at lookup time (the pitcher's count
        # tendency); see pitcher_vs_batter_pitch/_zone.
        vs_batter_pitch_counts = {}
        vs_batter_zone_counts = {}
        for batter_id, bg in g.groupby("batter"):
            vs_batter_pitch_counts[int(batter_id)] = bg["pitch_type"].value_counts().to_dict()
            vs_batter_zone_counts[int(batter_id)] = bg["zone"].value_counts().to_dict()

        profiles[int(pid)] = {
            "n_pitches": int(len(g)),
            "throws": g["p_throws"].mode().iat[0] if not g["p_throws"].mode().empty else "R",
            "overall_pitch": overall_pitch,
            "overall_zone": overall_zone,
            "by_count_pitch": by_count_pitch,
            "by_count_zone": by_count_zone,
            "zone_by_pitch": zone_by_pitch,
            "velo_by_pitch": velo_by_pitch,
            "vs_batter_pitch_counts": vs_batter_pitch_counts,
            "vs_batter_zone_counts": vs_batter_zone_counts,
        }
    return {"profiles": profiles, "pitch_labels": pitch_labels, "zone_labels": zone_labels}


def build_batter_profiles(df: pd.DataFrame) -> dict:
    """For each batter: overall distribution of pitch types/zones they see,
    plus how often each pitch type has actually gone for a hit against them --
    a pitcher should lean away from whatever this batter hits well, not just
    what they're generically thrown."""
    profiles = {}
    pitch_labels = sorted(df["pitch_type"].unique())
    zone_labels = ALL_ZONES

    has_events = "events" in df.columns
    if has_events:
        decisive = df[df["events"].notna()].copy()
        decisive["is_hit"] = decisive["events"].isin(HIT_EVENTS)

    for bid, g in df.groupby("batter"):
        overall_hit_rate = 0.0
        hit_rate_by_pitch = {}
        hit_rate_by_zone = {}
        if has_events:
            bd = decisive[decisive["batter"] == bid]
            total_decisive = len(bd)
            overall_hit_rate = (bd["is_hit"].sum() / total_decisive) if total_decisive else 0.0
            for pitch, pg in bd.groupby("pitch_type"):
                hits = pg["is_hit"].sum()
                hit_rate_by_pitch[pitch] = _shrunk_rate(hits, len(pg), overall_hit_rate)
            # Same idea, but by LOCATION instead of pitch type -- this is a
            # dense, batter-level signal (pooled across every pitcher this
            # batter has faced all season) rather than a specific pitcher/
            # batter pair, which is almost always too sparse (most pairs only
            # have a handful of pitches) to move a 13-way zone prediction on
            # its own. "Where does this guy actually do damage" generalizes
            # to any pitcher facing him, unlike pair-specific zone history.
            for zone, zg in bd.groupby("zone"):
                hits = zg["is_hit"].sum()
                hit_rate_by_zone[int(zone)] = _shrunk_rate(hits, len(zg), overall_hit_rate)

        profiles[int(bid)] = {
            "n_pitches": int(len(g)),
            "stand": g["stand"].mode().iat[0] if not g["stand"].mode().empty else "R",
            "overall_pitch": (g["pitch_type"].value_counts(normalize=True)
                              .reindex(pitch_labels, fill_value=0.0).to_dict()),
            "overall_zone": (g["zone"].value_counts(normalize=True)
                             .reindex(zone_labels, fill_value=0.0).to_dict()),
            "overall_hit_rate": float(overall_hit_rate),
            "hit_rate_by_pitch": hit_rate_by_pitch,
            "hit_rate_by_zone": hit_rate_by_zone,
        }
    return {"profiles": profiles, "pitch_labels": pitch_labels, "zone_labels": zone_labels}


def batter_hit_rate_for_pitch(batter_profile: dict, pitch_code: str) -> float:
    """How often this pitch type has gone for a hit against this batter,
    falling back to their overall hit rate if that pitch type is too sparse
    (or unseen) in the data."""
    hit_rate_by_pitch = batter_profile.get("hit_rate_by_pitch", {})
    return hit_rate_by_pitch.get(pitch_code, batter_profile.get("overall_hit_rate", 0.0))


def batter_hit_rate_for_zone(batter_profile: dict, zone: int) -> float:
    """How often pitches in this zone have gone for a hit against this
    batter, falling back to their overall hit rate if that zone is too
    sparse (or unseen) in the data."""
    hit_rate_by_zone = batter_profile.get("hit_rate_by_zone", {})
    return hit_rate_by_zone.get(int(zone), batter_profile.get("overall_hit_rate", 0.0))


def pitcher_count_dist(pitcher_profile: dict, kind: str, balls: int, strikes: int) -> dict:
    """Look up a pitcher's blended distribution for a specific count, falling
    back to their overall distribution if that exact count was never seen."""
    key = (int(balls), int(strikes))
    by_count = pitcher_profile[f"by_count_{kind}"]
    if key in by_count:
        return by_count[key]
    return pitcher_profile[f"overall_{kind}"]


def pitcher_runners_dist(pitcher_profile: dict, kind: str, on_1b: bool, on_2b: bool, on_3b: bool) -> dict:
    """Look up a pitcher's blended pitch/zone distribution for this exact
    combination of runners on base (e.g. more fastballs with a runner on
    1st to help the catcher control the running game), falling back to
    their overall distribution if that exact base state was never seen."""
    key = (int(bool(on_1b)), int(bool(on_2b)), int(bool(on_3b)))
    by_runners = pitcher_profile.get(f"by_runners_{kind}", {})
    if key in by_runners:
        return by_runners[key]
    return pitcher_profile[f"overall_{kind}"]


def pitcher_zone_for_pitch(pitcher_profile: dict, pitch_code: str) -> dict:
    """Where this pitcher's given pitch type tends to end up, falling back to
    their overall zone mix if they've never (or rarely) thrown that pitch."""
    zone_by_pitch = pitcher_profile.get("zone_by_pitch", {})
    return zone_by_pitch.get(pitch_code, pitcher_profile["overall_zone"])


def pitcher_zone_for_pitch_count(pitcher_profile: dict, pitch_code: str, balls: int, strikes: int) -> dict:
    """Where this pitcher's given pitch type tends to end up IN THIS SPECIFIC
    count (e.g. a slider buried low-away on 3-2 vs. left up more on 1-1).
    Falls back to that pitch type's overall zone mix, then the pitcher's
    overall zone mix, if the exact (pitch, count) combo is too sparse to
    have been recorded."""
    key = (int(balls), int(strikes))
    by_pitch_count = pitcher_profile.get("zone_by_pitch_count", {})
    by_count = by_pitch_count.get(pitch_code, {})
    if key in by_count:
        return by_count[key]
    return pitcher_zone_for_pitch(pitcher_profile, pitch_code)


def pitcher_vs_batter_pitch(pitcher_profile: dict, batter_id: int, base_dist: dict, k: float = MATCHUP_K) -> dict:
    """What has this SPECIFIC pitcher actually thrown to this SPECIFIC
    batter, pitch-type-wise -- shrunk toward `base_dist` (typically the
    pitcher's count-conditioned tendency) so a thin or nonexistent history
    against this exact batter falls back to "what does this pitcher
    generally do in this count," while real matchup history nudges the
    prediction toward how this pitcher has actually attacked this hitter."""
    counts = pitcher_profile.get("vs_batter_pitch_counts", {}).get(int(batter_id), {})
    return _shrunk_dist(counts, base_dist, k=k)


def pitcher_vs_batter_zone(pitcher_profile: dict, batter_id: int, base_dist: dict, k: float = MATCHUP_K) -> dict:
    """Same idea as pitcher_vs_batter_pitch, but for pitch location."""
    counts = pitcher_profile.get("vs_batter_zone_counts", {}).get(int(batter_id), {})
    return _shrunk_dist(counts, base_dist, k=k)


def pitcher_velo_for_pitch(pitcher_profile: dict, pitch_code: str) -> float | None:
    """This pitcher's average velocity (mph) for a given pitch type, falling
    back to their overall average velocity if they've never thrown it, or
    None if no velocity data is available at all (e.g. older pulls)."""
    velo_by_pitch = pitcher_profile.get("velo_by_pitch", {})
    if pitch_code in velo_by_pitch:
        return velo_by_pitch[pitch_code]
    if velo_by_pitch:
        return round(sum(velo_by_pitch.values()) / len(velo_by_pitch), 1)
    return None


def make_feature_row(
    situation: dict,
    pitcher_profile: dict,
    batter_profile: dict,
    batter_id: int,
    pitch_labels: list[str],
    zone_labels: list[int],
) -> dict:
    """Build one feature dict (situation + pitcher/batter tendency rates)."""
    row = {
        "balls": situation["balls"],
        "strikes": situation["strikes"],
        "outs_when_up": situation["outs_when_up"],
        "inning": situation["inning"],
        "is_top_inning": situation["is_top_inning"],
        "on_1b": situation["on_1b"],
        "on_2b": situation["on_2b"],
        "on_3b": situation["on_3b"],
        "score_diff": situation["score_diff"],
        "stand_R": situation["stand_R"],
        "throws_R": situation["throws_R"],
    }

    count_pitch = pitcher_count_dist(pitcher_profile, "pitch", situation["balls"], situation["strikes"])
    count_zone = pitcher_count_dist(pitcher_profile, "zone", situation["balls"], situation["strikes"])
    # This pitcher's real pitch/zone mix conditioned on who's actually on
    # base right now (e.g. more fastballs with a runner on 1st to help
    # control the running game), independent of the count-based signal above.
    runners_pitch = pitcher_runners_dist(
        pitcher_profile, "pitch", situation["on_1b"], situation["on_2b"], situation["on_3b"])
    runners_zone = pitcher_runners_dist(
        pitcher_profile, "zone", situation["on_1b"], situation["on_2b"], situation["on_3b"])
    # What has THIS pitcher actually thrown/located against THIS batter,
    # specifically -- shrunk toward the pitcher's count tendency above. This
    # is the direct "how does the pitcher choose to attack this hitter"
    # signal the raw pitcher/batter tendency features above can't capture on
    # their own (those only see "pitcher's general mix" and "what pitches
    # this batter tends to see league-wide," never the actual matchup).
    vs_batter_pitch = pitcher_vs_batter_pitch(pitcher_profile, batter_id, count_pitch)
    vs_batter_zone = pitcher_vs_batter_zone(pitcher_profile, batter_id, count_zone)
    for p in pitch_labels:
        row[f"pit_overall_{p}"] = pitcher_profile["overall_pitch"].get(p, 0.0)
        row[f"pit_count_{p}"] = count_pitch.get(p, 0.0)
        row[f"pit_runners_{p}"] = runners_pitch.get(p, 0.0)
        row[f"pit_vsbat_{p}"] = vs_batter_pitch.get(p, 0.0)
        row[f"bat_seen_{p}"] = batter_profile["overall_pitch"].get(p, 0.0)
        row[f"bat_hitrate_{p}"] = batter_hit_rate_for_pitch(batter_profile, p)
    for z in zone_labels:
        row[f"pitz_overall_{z}"] = pitcher_profile["overall_zone"].get(z, 0.0)
        row[f"pitz_count_{z}"] = count_zone.get(z, 0.0)
        row[f"pitz_runners_{z}"] = runners_zone.get(z, 0.0)
        row[f"pitz_vsbat_{z}"] = vs_batter_zone.get(z, 0.0)
        row[f"batz_seen_{z}"] = batter_profile["overall_zone"].get(z, 0.0)
        row[f"batz_hitrate_{z}"] = batter_hit_rate_for_zone(batter_profile, z)

    return row


def feature_columns(pitch_labels: list[str], zone_labels: list[int]) -> list[str]:
    cols = list(SITUATION_COLS)
    for p in pitch_labels:
        cols += [f"pit_overall_{p}", f"pit_count_{p}", f"pit_runners_{p}", f"pit_vsbat_{p}", f"bat_seen_{p}", f"bat_hitrate_{p}"]
    for z in zone_labels:
        cols += [f"pitz_overall_{z}", f"pitz_count_{z}", f"pitz_runners_{z}", f"pitz_vsbat_{z}", f"batz_seen_{z}", f"batz_hitrate_{z}"]
    return cols
