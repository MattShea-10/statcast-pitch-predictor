import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Line, Html } from "@react-three/drei";
import * as THREE from "three";
import { buildPitchCurve, pitchDurationSeconds, ZONE_COORDS, batterBoxCenter } from "../three/pitchGeometry";
import { COLORS as PITCH_CHART_COLORS } from "./PitchTypeChart";

// Real strike-zone cell size (feet) for the in-zone 3x3 grid; corner "chase"
// zone cells are drawn a bit smaller than their spacing so they read as
// distinct tiles rather than one solid frame.
const CELL_W = 1.417 / 3;
const CELL_H = 2 / 3;
const CORNER_W = 0.85;
const CORNER_H = 0.85;

function zoneHeatColor(p, maxP) {
  const t = maxP > 0 ? Math.min(1, p / maxP) : 0;
  // interpolate from dark panel tone (cold) to red accent (hot)
  const r = Math.round(24 + t * (214 - 24));
  const g = Math.round(35 + t * (69 - 35));
  const b = Math.round(30 + t * (60 - 30));
  return `rgb(${r}, ${g}, ${b})`;
}

// Real home-plate outline (17in front edge, 17in front-to-tip depth), shared
// by the flat plate on the ground and the extruded strike-zone prism above it.
function homePlateShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.708, 0);
  s.lineTo(0.708, 0);
  s.lineTo(0.708, 0.708);
  s.lineTo(0, 1.416);
  s.lineTo(-0.708, 0.708);
  s.lineTo(-0.708, 0);
  return s;
}

// Real MLB basepaths: 90ft between consecutive bases, laid out as a square
// rotated 45 degrees from home plate (first/third 90/sqrt(2) ft out to
// either side, second base straight out at 90*sqrt(2) ft). Coordinates are
// [x, z] pairs in the same feet-as-world-units scale as the mound distance.
const HOME_XZ = [0, 0];
const FIRST_XZ = [63.64, 63.64];
const SECOND_XZ = [0, 127.28];
const THIRD_XZ = [-63.64, 63.64];

// Builds the 4 corners (in [x,z] world space) of a rectangular strip running
// from `from` to `to` with the given width, for dirt basepaths / foul lines.
function stripCorners(from, to, width) {
  const [ax, az] = from;
  const [bx, bz] = to;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = -uz * (width / 2), pz = ux * (width / 2);
  return [
    [ax + px, az + pz],
    [bx + px, bz + pz],
    [bx - px, bz - pz],
    [ax - px, az - pz],
  ];
}

// A flat ground-level strip between two [x,z] points -- used for both the
// dirt basepaths and the painted white foul lines. Built as a THREE.Shape
// with the strip's corners pre-computed in world x/z (negating z for the
// shape's local y, since the ground-flattening rotation below maps local
// y -> world -z), so no extra per-instance rotation math is needed.
function GroundStrip({ from, to, width, color, y = 0.015 }) {
  const shape = useMemo(() => {
    const pts = stripCorners(from, to, width);
    const s = new THREE.Shape();
    pts.forEach(([x, z], i) => {
      if (i === 0) s.moveTo(x, -z);
      else s.lineTo(x, -z);
    });
    s.lineTo(pts[0][0], -pts[0][1]);
    return s;
  }, [from, to, width]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color={color} side={THREE.DoubleSide} />
    </mesh>
  );
}

// Dirt cutout circle around a base or home plate.
function DirtCircle({ at, radius, y = 0.01 }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[at[0], y, at[1]]}>
      <circleGeometry args={[radius, 32]} />
      <meshStandardMaterial color="#8a6a45" />
    </mesh>
  );
}

// A base bag: a real, "thicker" 3D box (not a flat decal) sitting on top of
// its dirt cutout.
function Base({ at }) {
  return (
    <mesh position={[at[0], 0.1, at[1]]}>
      <boxGeometry args={[1.3, 0.2, 1.3]} />
      <meshStandardMaterial color="#e6e6e0" />
    </mesh>
  );
}

function Infield() {
  return (
    <group>
      {/* Sand-colored dirt basepaths connecting all 4 bases */}
      <GroundStrip from={HOME_XZ} to={FIRST_XZ} width={9} color="#8a6a45" />
      <GroundStrip from={FIRST_XZ} to={SECOND_XZ} width={9} color="#8a6a45" />
      <GroundStrip from={SECOND_XZ} to={THIRD_XZ} width={9} color="#8a6a45" />
      <GroundStrip from={THIRD_XZ} to={HOME_XZ} width={9} color="#8a6a45" />

      {/* Painted white foul lines, running from home through first/third
          and continuing out into the outfield */}
      <GroundStrip
        from={HOME_XZ}
        to={[FIRST_XZ[0] * 1.7, FIRST_XZ[1] * 1.7]}
        width={0.35}
        color="#e6e6e0"
        y={0.02}
      />
      <GroundStrip
        from={HOME_XZ}
        to={[THIRD_XZ[0] * 1.7, THIRD_XZ[1] * 1.7]}
        width={0.35}
        color="#e6e6e0"
        y={0.02}
      />

      {/* Dirt circles + thicker bases */}
      <DirtCircle at={HOME_XZ} radius={7} />
      <DirtCircle at={FIRST_XZ} radius={5.5} />
      <DirtCircle at={SECOND_XZ} radius={5.5} />
      <DirtCircle at={THIRD_XZ} radius={5.5} />
      <Base at={FIRST_XZ} />
      <Base at={SECOND_XZ} />
      <Base at={THIRD_XZ} />
    </group>
  );
}

// Presets whose view is "behind, left, or right" of home plate are marked
// targetsBatter: true so they orbit around wherever the actual batter is
// standing (which side of the plate depends on batter handedness) rather
// than a fixed downfield point.
const CAMERA_PRESETS = {
  catcher: { position: [0, 6, -13], target: [0, 3, 25], targetsBatter: true, label: "Catcher" },
  // z=56 (right at the real ~55ft release point) reads as noticeably far
  // away from home plate in a normal FOV -- pulled in closer for a tighter,
  // more immersive framing while still reading as "standing on the mound."
  pitcher: { position: [0, 5.5, 40], target: [0, 2.5, 0], label: "Pitcher" },
  // A real pitcher's eye-line: standing at the rubber (z=60.5) at roughly
  // eye height (~6.5ft, mound top + a standing player's eyes), looking
  // straight down the throwing lane at the catcher's target just in front
  // of home plate -- not the old z=66/y=9 spot, which sat behind and well
  // above the rubber and read as an odd elevated/backward angle rather than
  // "the pitcher looking at home plate."
  mound: { position: [0, 6.5, 61], target: [0, 2.6, -3], label: "Mound" },
  leftSide: { position: [-32, 9, 10], target: [0, 3, 5], targetsBatter: true, label: "Left Side" },
  rightSide: { position: [32, 9, 10], target: [0, 3, 5], targetsBatter: true, label: "Right Side" },
  top: { position: [0.01, 34, 0.01], target: [0, 0, 0], label: "Top" },
  vsRHB: { position: [-15, 7, 4], target: [-2.7, 2, -1.5], label: "Vs RHB" },
  vsLHB: { position: [15, 7, 4], target: [2.7, 2, -1.5], label: "Vs LHB" },
};

// Keep the free-roam camera (drag-to-orbit, scroll-to-zoom, and the manual
// pan buttons) from wandering past a few feet behind the catcher or a few
// feet behind the pitcher's mound (60.5ft) -- the whole scene is built
// around that pitcher/catcher/batter corridor, so there's nothing useful
// past those bounds anyway.
const CAMERA_MIN_Z = -18; // a few feet behind the catcher
const CAMERA_MAX_Z = 68; // a few feet behind the pitcher's mound

function CameraBoundary() {
  const { camera, controls } = useThree();
  useFrame(() => {
    const z = camera.position.z;
    if (z < CAMERA_MIN_Z || z > CAMERA_MAX_Z) {
      camera.position.z = Math.min(CAMERA_MAX_Z, Math.max(CAMERA_MIN_Z, z));
      if (controls) controls.update();
    }
  });
  return null;
}

function Field() {
  // Wide enough to comfortably hold first/third base (63.6ft either side
  // of home) and deep enough to reach past second base, even though the
  // camera boundary keeps normal viewing much closer in.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 55]} receiveShadow>
      <planeGeometry args={[180, 170]} />
      <meshStandardMaterial color="#1c3a1e" />
    </mesh>
  );
}

function Mound() {
  return (
    <group position={[0, 0, 60.5]}>
      <mesh position={[0, 0.3, 0]}>
        <cylinderGeometry args={[8, 9, 0.6, 32]} />
        <meshStandardMaterial color="#5a3d20" />
      </mesh>
      <mesh position={[0, 0.63, 0]}>
        <boxGeometry args={[2, 0.08, 0.5]} />
        <meshStandardMaterial color="#e6e6e0" />
      </mesh>
    </group>
  );
}

function HomePlate() {
  const shape = useMemo(() => homePlateShape(), []);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color="#e6e6e0" side={THREE.DoubleSide} />
    </mesh>
  );
}

// A pair of stance footprints -- feet roughly shoulder-width apart,
// slightly staggered front-to-back like a real batting stance -- so the
// batter box shows *where* the batter is actually standing rather than
// just an outlined rectangle.
function Footprints() {
  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
      {[
        { x: -0.6, y: -0.15 },
        { x: 0.6, y: 0.15 },
      ].map((f, i) => (
        <mesh key={i} position={[f.x, f.y, 0]} scale={[0.4, 0.75, 1]}>
          <circleGeometry args={[1, 24]} />
          <meshStandardMaterial color="#2a2118" transparent opacity={0.6} />
        </mesh>
      ))}
    </group>
  );
}

function BatterBox({ side, active }) {
  return (
    <group position={[side * 2.7, 0, -1.5]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[3.5, 6]} />
        <meshStandardMaterial
          color="#e6e6e0"
          transparent
          opacity={active ? 0.2 : 0.06}
        />
      </mesh>
      <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(3.5, 6)]} />
        <lineBasicMaterial color="#e6e6e0" />
      </lineSegments>
      {active && <Footprints />}
    </group>
  );
}

// Strike zone starts around the knees and ends around the letters -- a 2ft
// span is a reasonable average, from 1.5ft to 3.5ft off the ground.
const ZONE_BOTTOM_FT = 1.5;
const ZONE_HEIGHT_FT = 2;

function StrikeZone({ zoneData }) {
  const byZone = useMemo(
    () => Object.fromEntries((zoneData || []).map((d) => [d.zone, d])),
    [zoneData]
  );
  const maxP = useMemo(() => {
    const probs = (zoneData || []).map((d) => d.probability);
    return probs.length ? Math.max(...probs) : 0;
  }, [zoneData]);
  // The most likely single spot specifically among the 9 in-zone cells --
  // the 4 corner "chase" buckets each cover a much bigger area than any one
  // in-zone cell, so they usually win the raw top-1 pick even when strikes
  // and balls are roughly split. Highlighting this cell keeps "where does
  // it go if it's a strike" visible at a glance.
  const bestInZone = useMemo(() => {
    const inZone = (zoneData || []).filter((d) => d.zone <= 9);
    return inZone.length ? inZone.reduce((a, b) => (b.probability > a.probability ? b : a)) : null;
  }, [zoneData]);

  // The strike zone as a home-plate-shaped prism: the exact same pentagon
  // outline as home plate, extruded straight up from the ground through the
  // real strike-zone height, instead of a generic rectangular box.
  const shape = useMemo(() => homePlateShape(), []);
  const extrudeGeometry = useMemo(
    () => new THREE.ExtrudeGeometry(shape, { depth: ZONE_HEIGHT_FT, bevelEnabled: false }),
    [shape]
  );

  return (
    <group>
      {/* Real strike-zone volume: home plate's outline, extruded to the
          zone's real height. Rotating -90deg about X turns the extrusion
          axis (local Z) into world "up" (Y), so the footprint lines up
          exactly with home plate on the ground below it. */}
      <mesh
        geometry={extrudeGeometry}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, ZONE_BOTTOM_FT, 0]}
      >
        <meshBasicMaterial color="#c7d3c9" transparent opacity={0.05} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments rotation={[-Math.PI / 2, 0, 0]} position={[0, ZONE_BOTTOM_FT, 0]}>
        <edgesGeometry args={[extrudeGeometry]} />
        <lineBasicMaterial color="#c7d3c9" />
      </lineSegments>

      {/* Location chart, overlaid cell-by-cell on the real zone */}
      {Object.entries(ZONE_COORDS).map(([zoneStr, coord]) => {
        const zoneNum = Number(zoneStr);
        const isCorner = zoneNum >= 11;
        const w = (isCorner ? CORNER_W : CELL_W) * 0.9;
        const h = (isCorner ? CORNER_H : CELL_H) * 0.9;
        const d = byZone[zoneNum];
        const pct = d ? Math.round(d.probability * 1000) / 10 : 0;
        const color = zoneHeatColor(d ? d.probability : 0, maxP);
        const isBestStrike = bestInZone && zoneNum === bestInZone.zone;

        return (
          <group key={zoneNum} position={[coord.x, coord.y, 0.02]}>
            <mesh>
              <planeGeometry args={[w, h]} />
              <meshBasicMaterial
                color={color}
                transparent
                opacity={zoneData ? (isCorner ? 0.55 : 0.78) : 0}
                side={THREE.DoubleSide}
              />
            </mesh>
            {isBestStrike && (
              <lineSegments>
                <edgesGeometry args={[new THREE.PlaneGeometry(w, h)]} />
                <lineBasicMaterial color="#e0b73a" linewidth={2} />
              </lineSegments>
            )}
            {zoneData && (
              <Html center distanceFactor={16} style={{ pointerEvents: "none" }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#f5f5f0",
                    textShadow: "0 1px 3px rgba(0,0,0,0.85)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pct}%
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

function PitchBall({ curve, duration, trigger, color = "#ffffff" }) {
  const ref = useRef();
  const startRef = useRef(null);
  // Recomputed from `curve` on every change via useMemo -- NOT useRef.
  // useRef's initial value only ever gets captured once, on first mount, so
  // if this had stayed a ref, the ball would keep animating correctly along
  // each NEW curve mid-flight but then snap back to wherever the very FIRST
  // prediction ever landed once it finished (t >= 1), making it look frozen
  // in one spot no matter what the current prediction actually says.
  const donePos = useMemo(() => curve.getPoint(1), [curve]);

  useEffect(() => {
    startRef.current = null;
  }, [trigger, curve, duration]);

  useFrame((state) => {
    if (!ref.current) return;
    if (startRef.current === null) startRef.current = state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - startRef.current) / duration);
    const p = t >= 1 ? donePos : curve.getPoint(t);
    ref.current.position.set(p.x, p.y, p.z);
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.13, 16, 16]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} />
    </mesh>
  );
}

// One ranked pitch's full flight path: the arc, the moving ball, and a
// floating rank/name/probability label parked just past where it arrives --
// used to show up to the top 5 most likely pitches at once (user-selectable
// count), each in its own color, instead of only ever showing a single "the"
// prediction.
function RankedPitchTrail({ rank, code, zone, throwsR, trigger, color, name, probability }) {
  const curve = useMemo(() => buildPitchCurve(code, zone, throwsR), [code, zone, throwsR]);
  const duration = useMemo(() => pitchDurationSeconds(code), [code]);
  const curvePoints = useMemo(() => curve.getPoints(60), [curve]);
  const endPos = useMemo(() => curve.getPoint(1), [curve]);

  return (
    <group>
      <Line points={curvePoints} color={color} lineWidth={rank === 1 ? 2.5 : 1.75} transparent opacity={rank === 1 ? 0.8 : 0.55} />
      <PitchBall curve={curve} duration={duration} trigger={trigger} color={color} />
      <Html
        position={[endPos.x, endPos.y + 0.5, endPos.z]}
        center
        distanceFactor={16}
        style={{ pointerEvents: "none" }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            color,
            textShadow: "0 1px 3px rgba(0,0,0,0.9)",
            whiteSpace: "nowrap",
          }}
        >
          #{rank} {name} · {Math.round(probability * 1000) / 10}%
        </div>
      </Html>
    </group>
  );
}

// Same palette (and same index-by-rank assignment) as the pitch-type bar
// chart, so pitch #1 flies the same color as its bar there, #2 matches its
// bar, and so on -- one consistent color per ranked pitch across both views.
const RANK_COLORS = PITCH_CHART_COLORS;

function CameraRig({ preset, standR, panX }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    const cfg = CAMERA_PRESETS[preset] || CAMERA_PRESETS.catcher;
    camera.position.set(cfg.position[0] + panX, cfg.position[1], cfg.position[2]);
    const target = cfg.targetsBatter
      ? [batterBoxCenter(standR).x, 2, -1.5]
      : cfg.target;
    if (controls) {
      controls.target.set(target[0] + panX, target[1], target[2]);
      controls.update();
    } else {
      camera.lookAt(target[0] + panX, target[1], target[2]);
    }
    // Note: panX intentionally re-applies the full camera position/target
    // on every change (not an incremental nudge), so switching presets while
    // panned still lands in a predictable, centered-plus-offset spot rather
    // than compounding with whatever pan was left over from a prior preset.
  }, [preset, camera, controls, standR, panX]);
  return null;
}

const PAN_STEP = 6;
const PAN_LIMIT = 40;

export default function PitchTrajectory3D({ pitchCode, pitchName, zone, zoneData, topPitches, throwsR = true, standR = true }) {
  const [trigger, setTrigger] = useState(0);
  const [preset, setPreset] = useState("catcher");
  const [panX, setPanX] = useState(0);
  const hasPrediction = Boolean(pitchCode && zone);

  // The ranked pitches to actually fly across the zone at once (however many
  // the caller passed in, up to the 5 colors available), each with its own
  // most-likely landing zone. Falls back to the single active pitch if
  // topPitches wasn't provided (or has no usable entries), so this still
  // works from anywhere that hasn't been updated to pass ranked pitches.
  const rankedTrails = useMemo(() => {
    const list = (topPitches || []).filter((p) => p.code && p.zone != null);
    if (list.length > 0) return list.slice(0, RANK_COLORS.length);
    return hasPrediction ? [{ code: pitchCode, name: pitchName, zone, probability: null }] : [];
  }, [topPitches, hasPrediction, pitchCode, pitchName, zone]);

  function selectPreset(key) {
    setPreset(key);
    setPanX(0); // start each preset from its centered position, not a leftover pan
  }

  function pan(direction) {
    setPanX((x) => Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, x + direction * PAN_STEP)));
  }

  useEffect(() => {
    if (hasPrediction) setTrigger((t) => t + 1);
  }, [hasPrediction, pitchCode, zone, throwsR, topPitches]);

  // Honest in-zone-vs-out-of-zone split -- the 4 corner "chase" buckets each
  // cover far more physical area than any single in-zone cell, so a corner
  // often wins "most likely single spot" even when strikes and balls are
  // roughly even overall.
  const strikePct = useMemo(() => {
    if (!zoneData) return null;
    const total = zoneData.filter((d) => d.zone <= 9).reduce((sum, d) => sum + d.probability, 0);
    return Math.round(total * 1000) / 10;
  }, [zoneData]);

  return (
    <div className="relative h-full w-full">
      <Canvas shadows camera={{ position: CAMERA_PRESETS.catcher.position, fov: 50 }}>
        <color attach="background" args={["#0a0f0b"]} />
        <fog attach="fog" args={["#0a0f0b", 40, 130]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[10, 20, -10]} intensity={0.85} />
        <Field />
        <Infield />
        <Mound />
        <HomePlate />
        <BatterBox side={standR ? -1 : 1} active={hasPrediction} />
        <BatterBox side={standR ? 1 : -1} active={false} />
        <StrikeZone zoneData={hasPrediction ? zoneData : null} />
        {rankedTrails.map((p, i) => (
          <RankedPitchTrail
            key={p.code + i}
            rank={i + 1}
            code={p.code}
            zone={p.zone}
            name={p.name}
            probability={p.probability ?? 0}
            throwsR={throwsR}
            trigger={trigger}
            color={RANK_COLORS[i] || RANK_COLORS[0]}
          />
        ))}
        <CameraRig preset={preset} standR={standR} panX={panX} />
        <CameraBoundary />
        <OrbitControls makeDefault maxDistance={90} minDistance={8} />
      </Canvas>

      {!hasPrediction && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded border border-base-300 bg-base-100/70 px-4 py-2 text-xs uppercase tracking-widest text-base-content/50">
            Set the situation and predict
          </span>
        </div>
      )}

      {/* lg:top-20 clears the floating header's "Model" text; lg:right-[380px]
          (same convention as the pan buttons below) keeps this inside the
          visible gap between the two 360px sidebars on desktop instead of
          sitting at the true viewport edge, which is underneath/behind the
          right sidebar's content and was overlapping it. */}
      <div className="absolute top-2 right-2 flex max-w-[75%] flex-wrap justify-end gap-1 rounded border border-base-300 bg-base-100/80 p-1 backdrop-blur-sm sm:top-4 sm:right-4 lg:top-20 lg:right-[380px] lg:max-w-[320px]">
        {Object.entries(CAMERA_PRESETS).map(([key, cfg]) => (
          <button
            key={key}
            className={`btn btn-xs ${preset === key ? "btn-primary" : "btn-ghost"}`}
            onClick={() => selectPreset(key)}
          >
            {cfg.label}
          </button>
        ))}
      </div>

      {/* Manual left/right camera pan, on top of the fixed presets and the
          orbit-drag already available via the mouse/touch controls. Pinned
          inside the left/right sidebars' edges from lg up, since the
          sidebars would otherwise cover a button sitting at the true
          viewport edge. */}
      <div className="pointer-events-none absolute inset-y-0 left-2 flex items-center sm:left-4 lg:left-[380px]">
        <button
          className="pointer-events-auto btn btn-circle btn-xs sm:btn-sm border border-base-300 bg-base-100/80 backdrop-blur-sm"
          onClick={() => pan(-1)}
          disabled={panX <= -PAN_LIMIT}
          aria-label="Pan camera left"
        >
          &#8592;
        </button>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center sm:right-4 lg:right-[380px]">
        <button
          className="pointer-events-auto btn btn-circle btn-xs sm:btn-sm border border-base-300 bg-base-100/80 backdrop-blur-sm"
          onClick={() => pan(1)}
          disabled={panX >= PAN_LIMIT}
          aria-label="Pan camera right"
        >
          &#8594;
        </button>
      </div>

      {hasPrediction && (
        <button
          className="btn btn-primary btn-xs sm:btn-sm absolute bottom-12 right-2 sm:bottom-14 sm:right-4"
          onClick={() => setTrigger((t) => t + 1)}
        >
          &#8635; Replay
        </button>
      )}

      {hasPrediction && strikePct != null && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded border border-base-300 bg-base-100/80 px-2 py-1 text-[10px] backdrop-blur-sm sm:top-3 sm:px-3 sm:py-1.5 sm:text-[11px] lg:top-20">
          <span className="font-semibold text-success">{strikePct}%</span>
          <span className="text-base-content/50"> in zone · </span>
          <span className="font-semibold text-error">{Math.round((100 - strikePct) * 10) / 10}%</span>
          <span className="text-base-content/50"> out of zone</span>
        </div>
      )}

      <div className="absolute bottom-2 left-1/2 w-[85%] -translate-x-1/2 text-center text-[10px] text-base-content/40 sm:bottom-4 sm:w-auto sm:text-[11px]">
        {hasPrediction
          ? rankedTrails.length > 1
            ? `Top ${rankedTrails.length}: ${rankedTrails.map((p) => p.name).join(", ")} · drag to orbit, scroll to zoom`
            : `${pitchName} · drag to orbit, scroll to zoom`
          : "Trajectory shape reflects each pitch type's typical velocity and movement — illustrative, not a physics reconstruction."}
      </div>
    </div>
  );
}
