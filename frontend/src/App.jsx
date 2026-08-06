import { useEffect, useState } from "react";
import TeamPlayerSelect from "./components/TeamPlayerSelect";
import CountSelector from "./components/CountSelector";
import BaseRunners from "./components/BaseRunners";
import PitchTypeChart from "./components/PitchTypeChart";
import StrikeZoneHeatmap from "./components/StrikeZoneHeatmap";
import PitchTrajectory3D from "./components/PitchTrajectory3D";
import { getHealth, predictNextPitch, verifyPredictions } from "./api";

const initialSituation = {
  inning: 1,
  is_top_inning: true,
  balls: 0,
  strikes: 0,
  outs_when_up: 0,
  on_1b: false,
  on_2b: false,
  on_3b: false,
  bat_score: 0,
  fld_score: 0,
};

const panel = "pointer-events-auto border border-base-300 bg-base-100/95 p-4";
const panelTitle = "mb-2 text-xs font-semibold uppercase tracking-widest text-base-content";
const helpText = "mt-2 text-[11px] leading-relaxed text-base-content/45";

// Remember the last pitcher/batter/situation across page reloads, so
// refreshing the app doesn't drop back to an empty state.
const STORAGE_KEY = "pitchPredictorState";

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupted JSON, storage disabled, etc. -- just start fresh
  }
}

const savedState = loadSavedState();

// A running log of every prediction made, so it can be checked against real
// pitches the next day once fresher Statcast data has been pulled. Kept in
// its own localStorage key (separate from the situation snapshot above) so
// it accumulates across sessions instead of being overwritten.
const TRACKED_KEY = "pitchPredictorTrackedPredictions";

function loadTrackedPredictions() {
  try {
    const raw = localStorage.getItem(TRACKED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [pitcher, setPitcher] = useState(savedState?.pitcher ?? null);
  const [batter, setBatter] = useState(savedState?.batter ?? null);
  const [batterSide, setBatterSide] = useState(savedState?.batterSide ?? null); // "L" | "R" | null (null = use their default recorded stance)
  const [situation, setSituation] = useState(savedState?.situation ?? initialSituation);
  const [result, setResult] = useState(null);
  const [selectedPitch, setSelectedPitch] = useState(null);
  // How many of the top-ranked pitches to fly across the 3D scene at once --
  // 1 shows just the top pick's trajectory/location, 5 shows all 5 flying
  // together, each in its own color.
  const [topNCount, setTopNCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [tracked, setTracked] = useState(loadTrackedPredictions);
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth({ status: "error" }));
  }, []);

  // Persist tracked predictions so they survive reloads -- these are meant
  // to pile up over a whole game (or several) before being checked.
  useEffect(() => {
    try {
      localStorage.setItem(TRACKED_KEY, JSON.stringify(tracked));
    } catch {
      // storage full / disabled -- not worth surfacing
    }
  }, [tracked]);

  // Persist the current pitcher/batter/situation on every change, so
  // reloading the page (or reopening the app later) picks up right where
  // you left off instead of resetting to empty.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ pitcher, batter, batterSide, situation }));
    } catch {
      // storage full / disabled (e.g. private browsing) -- not worth surfacing
    }
  }, [pitcher, batter, batterSide, situation]);

  function updateNumber(field, value, min, max) {
    const n = Math.max(min, Math.min(max, Number(value)));
    setSituation((s) => ({ ...s, [field]: n }));
  }

  function toggleRunner(field) {
    setSituation((s) => ({ ...s, [field]: !s[field] }));
  }

  function handleBatterChange(p) {
    setBatter(p);
    setBatterSide(null); // reset to their default side whenever the batter changes
  }

  const effectiveStand = batterSide || batter?.stand || "R";

  async function handlePredict() {
    if (!pitcher || !batter) {
      setError("Pick a pitcher and a batter first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await predictNextPitch({
        pitcher_id: pitcher.id,
        batter_id: batter.id,
        batter_stand: batter.switch_hitter ? effectiveStand : undefined,
        ...situation,
      });
      setResult(res);
      setSelectedPitch(null);
      logTrackedPrediction(res);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // Log this prediction (the top pitch + that pitch's top location) so it
  // can be checked against what actually happened once fresher data is
  // pulled -- e.g. the next morning after a game.
  function logTrackedPrediction(res) {
    const topCode = res?.pitch_type?.[0]?.code;
    if (!topCode) return;
    const zoneDist = res?.zone_by_pitch?.[topCode] || res?.zone;
    const topZone = bestZone(zoneDist)?.zone;
    if (topZone == null) return;
    const entry = {
      date: new Date().toISOString().slice(0, 10),
      pitcher_id: pitcher.id,
      batter_id: batter.id,
      inning: situation.inning,
      is_top_inning: situation.is_top_inning,
      balls: situation.balls,
      strikes: situation.strikes,
      outs_when_up: situation.outs_when_up,
      on_1b: situation.on_1b,
      on_2b: situation.on_2b,
      on_3b: situation.on_3b,
      predicted_pitch_code: topCode,
      predicted_zone: topZone,
    };
    setTracked((prev) => [...prev, entry]);
  }

  async function handleCheckAccuracy() {
    if (tracked.length === 0) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const res = await verifyPredictions(tracked);
      setVerifyResult(res);
    } catch (e) {
      setVerifyError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  function handleClearTracked() {
    setTracked([]);
    setVerifyResult(null);
    setVerifyError(null);
  }

  // Predict automatically as soon as both a pitcher and batter are picked
  // (at whatever count is on screen, 0-0 by default), and again whenever any
  // part of the situation changes afterward -- inning, outs, count, runners,
  // or score -- so the prediction and location box stay in sync without
  // needing to click Predict every time.
  useEffect(() => {
    if (pitcher && batter) {
      handlePredict();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pitcher,
    batter,
    batterSide,
    situation.inning,
    situation.is_top_inning,
    situation.balls,
    situation.strikes,
    situation.outs_when_up,
    situation.on_1b,
    situation.on_2b,
    situation.on_3b,
    situation.bat_score,
    situation.fld_score,
  ]);

  const notReady = health && health.status !== "ready";

  const activePitchCode = selectedPitch || result?.pitch_type?.[0]?.code || null;
  const activePitchName = result?.pitch_type?.find((p) => p.code === activePitchCode)?.name;
  const activeZoneData = (activePitchCode && result?.zone_by_pitch?.[activePitchCode]) || result?.zone;

  // The 4 out-of-zone "chase" buckets (11-14) are each a much bigger physical
  // area than any single one of the 9 in-zone cells, so a raw top-1-of-13
  // pick lands on one of those corners almost every time -- confirmed against
  // real Statcast data, where zone 14 alone is the single most common zone
  // even at a 3-2 count. That's honest about ball-vs-strike odds but not
  // useful as "the" predicted spot to fly a pitch at, since it makes every
  // 3D trajectory look identical regardless of situation. Instead: decide
  // strike vs. ball from the full distribution first (same split already
  // shown in the heatmap), then take the single most likely cell *within*
  // whichever side actually wins.
  function bestZone(dist) {
    if (!dist || dist.length === 0) return null;
    const inZone = dist.filter((d) => d.zone <= 9);
    const outZone = dist.filter((d) => d.zone > 9);
    const inSum = inZone.reduce((s, d) => s + d.probability, 0);
    const outSum = outZone.reduce((s, d) => s + d.probability, 0);
    const pool = inSum >= outSum && inZone.length ? inZone : outZone.length ? outZone : inZone;
    return pool.reduce((a, b) => (b.probability > a.probability ? b : a));
  }

  // Ignores the ball-vs-strike split entirely and just picks the single most
  // likely of the 9 in-zone cells -- used for the 3rd-5th ranked pitches so
  // they always land somewhere hittable in the zone (a real target a pitcher
  // might actually throw for a strike) instead of occasionally landing in an
  // out-of-zone chase corner, which reads oddly for a pitch that's already
  // the 3rd-5th most likely candidate rather than "the" pick.
  function bestInZone(dist) {
    if (!dist || dist.length === 0) return null;
    const inZone = dist.filter((d) => d.zone <= 9);
    const pool = inZone.length ? inZone : dist;
    return pool.reduce((a, b) => (b.probability > a.probability ? b : a));
  }

  // The top N most likely pitches (already ranked by probability, N picked
  // by the user via the selector below), each paired with where THAT
  // specific pitch tends to go -- so the 3D view can fly all N realistic
  // paths at once instead of just the single top pick. Only the top 2 use
  // the honest ball-vs-strike-aware pick; ranks 3-5 are routed to their most
  // likely in-zone (strike) location instead -- see bestInZone above.
  const topNPitches = (result?.pitch_type || []).slice(0, topNCount).map((p, i) => {
    const zoneDist = result?.zone_by_pitch?.[p.code];
    const zonePick = i < 2 ? bestZone(zoneDist) : bestInZone(zoneDist);
    return {
      code: p.code,
      name: p.name,
      probability: p.probability,
      zone: zonePick?.zone ?? null,
    };
  });

  // Clicking a specific bar in the pitch-type chart (setting selectedPitch)
  // is a deliberate "show me THIS one" pick, even if it isn't one of the
  // currently-flying top-N ranked pitches -- so it overrides the top-N group
  // in the 3D scene with that single pitch's own trajectories: one flight to
  // its single most likely spot overall (which can honestly be a ball, off
  // the plate), and a second flight to its most likely STRIKE-ZONE cell, so
  // both "where's it really going" and "where would it be if it's a strike"
  // are visible at once. When those two picks are the same cell, only one
  // trajectory shows. Both use the clicked bar's own chart color; the labels
  // distinguish them. Reverts to the top-N group once a new prediction runs
  // (selectedPitch resets then).
  const manuallyPickedIndex = selectedPitch
    ? (result?.pitch_type || []).findIndex((p) => p.code === selectedPitch)
    : -1;
  const manuallyPickedPitch = manuallyPickedIndex >= 0 ? result.pitch_type[manuallyPickedIndex] : null;
  let manualTrail = null;
  if (manuallyPickedPitch) {
    const dist = result?.zone_by_pitch?.[manuallyPickedPitch.code];
    const overallPick = bestZone(dist);
    const strikePick = bestInZone(dist);
    const base = {
      code: manuallyPickedPitch.code,
      probability: manuallyPickedPitch.probability,
      // True rank + bar-chart color index, not this array's position -- so
      // e.g. picking the 4th-ranked pitch still shows "#4" in the same color
      // as the 4th bar in the chart.
      rank: manuallyPickedIndex + 1,
      colorIndex: manuallyPickedIndex,
    };
    manualTrail = [];
    if (overallPick?.zone != null) {
      manualTrail.push({
        ...base,
        zone: overallPick.zone,
        name: strikePick && strikePick.zone !== overallPick.zone
          ? `${manuallyPickedPitch.name} (most likely)`
          : manuallyPickedPitch.name,
      });
    }
    if (strikePick?.zone != null && strikePick.zone !== overallPick?.zone) {
      manualTrail.push({
        ...base,
        zone: strikePick.zone,
        name: `${manuallyPickedPitch.name} (best strike)`,
      });
    }
    if (manualTrail.length === 0) manualTrail = null;
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-y-auto font-mono text-base-content lg:fixed lg:inset-0 lg:block lg:overflow-hidden">
      {/* 3D scene: a fixed-height panel in normal page flow on small
          screens, a fullscreen background overlay from lg (1024px) up */}
      <div className="relative z-0 order-2 h-64 w-full sm:h-80 lg:absolute lg:inset-0 lg:order-none lg:h-full">
        <PitchTrajectory3D
          pitchCode={activePitchCode}
          pitchName={activePitchName}
          zone={bestZone(activeZoneData)?.zone}
          zoneData={activeZoneData}
          topPitches={manualTrail || topNPitches}
          throwsR={pitcher ? pitcher.throws === "R" : true}
          standR={batter ? effectiveStand === "R" : true}
        />
      </div>

      {/* Header: normal block on mobile, floating overlay from lg up */}
      <header className="relative z-10 order-1 flex flex-wrap items-start justify-between gap-3 border-b border-base-300 bg-base-100 p-4 sm:p-5 lg:absolute lg:inset-x-0 lg:top-0 lg:order-none lg:border-none lg:bg-transparent lg:pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-primary text-lg font-bold text-primary">
            P
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight sm:text-xl">
              NEXT-PITCH <span className="text-primary">PREDICTOR</span>
            </h1>
            <p className="text-[11px] text-base-content/50">
              Situational pitch prediction over real Statcast tendencies
            </p>
          </div>
        </div>
        <div className="pointer-events-auto text-right text-[11px] text-base-content/50">
          <div className="text-[10px] uppercase tracking-widest text-base-content/35">Model</div>
          <div className="text-base-content/70">Random Forest &middot; situational</div>
        </div>
      </header>

      {/* Left panel: full-width stacked block on mobile, floating sidebar from lg up */}
      <aside className="relative z-10 order-3 w-full space-y-3 p-4 sm:p-5 lg:pointer-events-none lg:absolute lg:top-24 lg:bottom-4 lg:left-0 lg:order-none lg:w-[360px] lg:overflow-y-auto lg:p-5 lg:pt-0">
        {notReady && (
          <div className={`${panel} border-warning/50 text-xs text-warning`}>
            Model isn't trained yet. Run <code>python -m app.data_pull</code> then{" "}
            <code>python -m app.train</code> in the backend, then reload.
          </div>
        )}

        <div className={panel}>
          <h2 className={panelTitle}>Select a pitcher</h2>
          <TeamPlayerSelect role="pitcher" label="Pitcher" value={pitcher} onChange={setPitcher} />
          <p className={helpText}>
            {result?.pitcher_description || (
              "Pick a team to load its staff. Each pitcher's model is built from " +
              "their real 2026 pitch mix, blended by count."
            )}
          </p>
        </div>

        <div className={panel}>
          <h2 className={panelTitle}>Select a batter</h2>
          <TeamPlayerSelect role="batter" label="Batter" value={batter} onChange={handleBatterChange} />

          {batter?.switch_hitter && (
            <div className="mt-2">
              <label className="mb-1 block text-xs text-base-content/60">Bats (switch hitter)</label>
              <div className="join w-full">
                <button
                  className={`join-item btn btn-xs flex-1 ${effectiveStand === "L" ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setBatterSide("L")}
                >Left</button>
                <button
                  className={`join-item btn btn-xs flex-1 ${effectiveStand === "R" ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setBatterSide("R")}
                >Right</button>
              </div>
            </div>
          )}

          <p className={helpText}>
            {result?.batter_description || (
              "Pick a team to load its lineup. This hitter's real tendencies " +
              "nudge the pitcher's baseline mix toward what they tend to see."
            )}
          </p>
        </div>

        <div className={panel}>
          <h2 className={panelTitle}>Situation</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-wide text-base-content/60">Inning</label>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-xs btn-square btn-outline"
                  onClick={() => updateNumber("inning", situation.inning - 1, 1, 20)}
                >-</button>
                <span className="min-w-[16px] text-center text-sm font-semibold">{situation.inning}</span>
                <button
                  className="btn btn-xs btn-square btn-outline"
                  onClick={() => updateNumber("inning", situation.inning + 1, 1, 20)}
                >+</button>
              </div>
              <div className="join mt-2 w-full">
                <button
                  className={`join-item btn btn-xs flex-1 ${situation.is_top_inning ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setSituation((s) => ({ ...s, is_top_inning: true }))}
                >Top</button>
                <button
                  className={`join-item btn btn-xs flex-1 ${!situation.is_top_inning ? "btn-primary" : "btn-outline"}`}
                  onClick={() => setSituation((s) => ({ ...s, is_top_inning: false }))}
                >Bot</button>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-wide text-base-content/60">Outs</label>
              <div className="flex items-center gap-1.5">
                {[0, 1, 2].map((o) => (
                  <button
                    key={o}
                    className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
                      situation.outs_when_up === o
                        ? "border-primary bg-primary text-primary-content"
                        : "border-base-300 bg-base-200 text-base-content/70 hover:bg-base-300"
                    }`}
                    onClick={() => setSituation((s) => ({ ...s, outs_when_up: o }))}
                  >{o}</button>
                ))}
              </div>
            </div>

            <CountSelector
              balls={situation.balls}
              strikes={situation.strikes}
              onChange={(b, s) => setSituation((sit) => ({ ...sit, balls: b, strikes: s }))}
            />

            <BaseRunners
              on1b={situation.on_1b}
              on2b={situation.on_2b}
              on3b={situation.on_3b}
              onToggle={toggleRunner}
            />

            <div className="col-span-2">
              <label className="mb-1.5 block text-xs uppercase tracking-wide text-base-content/60">
                Score (batting - fielding)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="input input-bordered input-sm w-[64px]"
                  value={situation.bat_score}
                  onChange={(e) => updateNumber("bat_score", e.target.value, 0, 30)}
                />
                <span className="text-base-content/40">-</span>
                <input
                  type="number"
                  className="input input-bordered input-sm w-[64px]"
                  value={situation.fld_score}
                  onChange={(e) => updateNumber("fld_score", e.target.value, 0, 30)}
                />
              </div>
            </div>
          </div>

          <button
            className="btn btn-secondary btn-block mt-4"
            onClick={handlePredict}
            disabled={loading}
          >
            {loading && <span className="loading loading-spinner loading-sm" />}
            {loading ? "Predicting..." : "Predict Next Pitch"}
          </button>
          {error && <p className="mt-2 text-xs text-error">{error}</p>}
        </div>
      </aside>

      {/* Right panel: full-width stacked block on mobile, floating sidebar from lg up */}
      <aside className="relative z-10 order-4 w-full p-4 sm:p-5 lg:pointer-events-none lg:absolute lg:top-24 lg:bottom-4 lg:right-0 lg:order-none lg:w-[360px] lg:overflow-y-auto lg:p-5 lg:pt-0">
        <div className={panel}>
          <h2 className={panelTitle}>Prediction</h2>
          {!result && (
            <p className="text-xs text-base-content/40">
              The model's ranked pitch candidates will appear here.
            </p>
          )}
          {result && (
            <>
              <div className="mb-2 mt-1 flex items-center justify-between">
                <h3 className="text-[11px] uppercase tracking-wide text-base-content/50">Pitch Type</h3>
                {result.pitch_type?.length > 0 && (
                  <label className="flex items-center gap-1.5 text-[11px] text-base-content/50">
                    Show top
                    <select
                      className="select select-bordered select-xs w-auto"
                      value={topNCount}
                      onChange={(e) => setTopNCount(Number(e.target.value))}
                      aria-label="How many top predicted pitches to fly across the 3D scene"
                    >
                      {Array.from({ length: Math.min(5, result.pitch_type.length) }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <PitchTypeChart data={result.pitch_type} selected={activePitchCode} onSelect={setSelectedPitch} />

              <h3 className="mb-2 mt-4 text-[11px] uppercase tracking-wide text-base-content/50">
                Location {activePitchName ? `— ${activePitchName}` : ""}
              </h3>
              <StrikeZoneHeatmap data={activeZoneData} />

              <div className="mt-4 border-t border-base-300 pt-2 text-[11px] text-base-content/40">
                Based on {result.pitcher_n_pitches?.toLocaleString()} pitches thrown by {pitcher?.name} and{" "}
                {result.batter_n_pitches?.toLocaleString()} pitches seen by {batter?.name} this season.
              </div>
            </>
          )}
        </div>

        <div className={`${panel} mt-3`}>
          <h2 className={panelTitle}>Accuracy Tracker</h2>
          <p className="text-xs text-base-content/60">
            {tracked.length === 0
              ? "No predictions logged yet."
              : `${tracked.length} prediction${tracked.length === 1 ? "" : "s"} logged.`}
          </p>
          <p className={helpText}>
            Every prediction is logged automatically. Pull fresh Statcast data
            (e.g. the next morning) and hit Check Accuracy to compare each
            logged prediction against what the pitcher actually threw.
          </p>

          <div className="mt-3 flex gap-2">
            <button
              className="btn btn-primary btn-sm flex-1"
              onClick={handleCheckAccuracy}
              disabled={tracked.length === 0 || verifying}
            >
              {verifying && <span className="loading loading-spinner loading-xs" />}
              {verifying ? "Checking..." : "Check Accuracy"}
            </button>
            <button
              className="btn btn-outline btn-sm"
              onClick={handleClearTracked}
              disabled={tracked.length === 0}
            >
              Clear
            </button>
          </div>

          {verifyError && <p className="mt-2 text-xs text-error">{verifyError}</p>}

          {verifyResult && (
            <div className="mt-3 space-y-1 border-t border-base-300 pt-2 text-xs">
              <div className="flex justify-between">
                <span className="text-base-content/50">Matched</span>
                <span>{verifyResult.n_matched} / {verifyResult.n_tracked}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/50">Pitch accuracy</span>
                <span className="font-semibold text-primary">
                  {verifyResult.pitch_accuracy != null
                    ? `${(verifyResult.pitch_accuracy * 100).toFixed(1)}%`
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/50">Location accuracy</span>
                <span className="font-semibold text-primary">
                  {verifyResult.zone_accuracy != null
                    ? `${(verifyResult.zone_accuracy * 100).toFixed(1)}%`
                    : "—"}
                </span>
              </div>
              {verifyResult.n_matched < verifyResult.n_tracked && (
                <p className="pt-1 text-[11px] text-base-content/40">
                  {verifyResult.n_tracked - verifyResult.n_matched} prediction
                  {verifyResult.n_tracked - verifyResult.n_matched === 1 ? "" : "s"} not
                  found yet in the data on disk -- pull the latest data and
                  re-check.
                </p>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
