# Statcast Next-Pitch Predictor

Pick a pitcher and a batter, set the game situation (inning, count, outs,
runners, score), and get a prediction for the next pitch: type (fastball,
slider, curveball, etc.) and location, both as probabilities.

## How it works

- **Data**: real 2026 Statcast pitch-by-pitch data, pulled from Baseball
  Savant via [pybaseball](https://github.com/jldbc/pybaseball).
- **Model**: for each pitcher, the training step builds a tendency profile
  (their overall pitch mix and location mix, plus a version blended by
  ball-strike count with shrinkage so small samples don't overfit). Batters
  get a similar profile for what they tend to see. A random forest is then
  trained on top of those tendency features plus situational context
  (inning, count, outs, runners, score, handedness) to predict the next
  pitch type and its location/zone.
- **Backend**: FastAPI, serves the trained model. Also tracks each player's
  current team (derived from home/away team + inning half on their most
  recent appearance, so mid-season trades resolve correctly) so the
  pitcher search can be filtered by team.
- **Frontend**: React (Vite) styled with Tailwind CSS v4 and daisyUI
  (custom dark "forecast" theme), talks to the backend over `/api`. The
  layout is a fullscreen 3D scene with the matchup/situation controls and
  the prediction panel floating over it as overlays; camera tabs
  (Catcher/Mound/Vs RHB/Vs LHB) switch the viewing angle.
- **3D trajectory view**: a Three.js scene (`@react-three/fiber` +
  `@react-three/drei`) renders a pitcher's mound, home plate, and batter's
  boxes, then animates the predicted pitch (top pitch type + top zone)
  flying from release point to the plate. The bend in the flight path is a
  stylized approximation driven by each pitch type's typical velocity and
  break (fastballs relatively straight, curveballs drop more, sliders/
  sweepers break sideways, etc.) — it's for illustration, not a physics-
  accurate reconstruction of the actual pitch.

## One-time setup

You need to run this on a normal machine/network — Baseball Savant isn't
reachable from network-locked sandboxes.

### 1. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt

# Pull this season's Statcast data (can take several minutes)
python -m app.data_pull

# Train the models
python -m app.train
```

This creates `backend/data/statcast_raw.parquet`, `backend/data/players.parquet`,
and the trained model files in `backend/models/`.

To pull a specific date range instead of the whole season so far:

```bash
python -m app.data_pull --start 2026-04-01 --end 2026-07-27
```

### 2. Run the backend API

```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

Check it's ready: `curl http://127.0.0.1:8000/api/health`

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the URL it prints (usually http://127.0.0.1:5173). The dev server
proxies `/api` requests to the backend on port 8000, so both need to be
running.

## Refreshing data

Statcast data updates as games are played. Re-run `data_pull.py` then
`train.py` whenever you want the model to reflect the latest games (e.g.
weekly, or before using it for an upcoming game).

## Notes / limitations

- Model quality depends on how many pitches a pitcher/batter has thrown or
  seen this season — early in the season, or for players with limited
  playing time, predictions lean more heavily on the situational
  (count/inning/etc.) signal and less on player-specific tendency.
- This predicts likelihood, not certainty — even the best next-pitch
  models plateau well under 100% accuracy because pitch selection has a
  real random/mixed-strategy component by design.
- Zone numbering follows Statcast's convention: 1-9 is the 3x3 strike zone
  grid (catcher's view), 11-14 are the four out-of-zone corners.
- The 3D scene needs a browser with WebGL (any modern desktop browser).
  After predicting, use "Replay pitch" to re-run the animation, and
  drag/scroll on the scene to orbit and zoom.
- Use the team dropdown next to the Pitcher search box to browse a whole
  staff instead of typing a name.
