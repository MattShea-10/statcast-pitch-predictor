// Field geometry + a stylized (not fully physical) pitch trajectory model,
// in feet, for the 3D visualization. Coordinate system:
//   x: horizontal, + = first-base side (viewer's right facing the mound), - = third-base side
//   y: vertical (up), 0 = ground
//   z: depth, 0 = front tip of home plate, + = toward the pitcher's mound

import * as THREE from "three";

export const MOUND_DISTANCE_FT = 60.5;       // rubber to back tip of plate
export const RELEASE_DISTANCE_FT = 55;       // approx release point distance from plate (extension-adjusted)
export const RELEASE_HEIGHT_FT = 5.9;
export const RELEASE_SIDE_OFFSET_FT = 2.0;   // how far off centerline a pitcher releases from

// Statcast zone numbering: 1-9 is the 3x3 strike zone (catcher's view),
// 11-14 are the four out-of-zone corners.
export const ZONE_COORDS = {
  1: { x: -0.56, y: 3.17 }, 2: { x: 0, y: 3.17 }, 3: { x: 0.56, y: 3.17 },
  4: { x: -0.56, y: 2.5 }, 5: { x: 0, y: 2.5 }, 6: { x: 0.56, y: 2.5 },
  7: { x: -0.56, y: 1.83 }, 8: { x: 0, y: 1.83 }, 9: { x: 0.56, y: 1.83 },
  11: { x: -1.3, y: 3.8 }, 12: { x: 1.3, y: 3.8 },
  13: { x: -1.3, y: 1.2 }, 14: { x: 1.3, y: 1.2 },
};

// Stylized typical velocity (mph) and movement (inches, from the pitcher's
// own perspective: hBreak + = glove side, - = arm side; vBreak + = more
// rise / less drop than an average fastball, - = more drop). These are
// rough league-average-ish figures for visualization, not per-pitcher data.
export const PITCH_PROFILES = {
  FF: { mph: 94, hBreak: -8, vBreak: 15 },
  SI: { mph: 93, hBreak: -15, vBreak: 8 },
  FC: { mph: 89, hBreak: 3, vBreak: 9 },
  SL: { mph: 85, hBreak: 5, vBreak: 1 },
  ST: { mph: 81, hBreak: 14, vBreak: -3 },
  CU: { mph: 78, hBreak: -6, vBreak: -9 },
  KC: { mph: 78, hBreak: -4, vBreak: -11 },
  CH: { mph: 85, hBreak: -14, vBreak: 5 },
  FS: { mph: 86, hBreak: -7, vBreak: -3 },
  KN: { mph: 70, hBreak: 0, vBreak: 0 },
};

const BREAK_EXAGGERATION = 3.0; // a few inches of real break is invisible at scale over 55ft

export function releasePoint(throwsR) {
  const side = throwsR ? -1 : 1; // RHP releases from third-base side (viewer's left)
  return new THREE.Vector3(side * RELEASE_SIDE_OFFSET_FT, RELEASE_HEIGHT_FT, RELEASE_DISTANCE_FT);
}

export function plateTargetPoint(zone) {
  const z = ZONE_COORDS[zone] || ZONE_COORDS[5];
  return new THREE.Vector3(z.x, z.y, 0);
}

export function batterBoxCenter(standR) {
  const side = standR ? -1 : 1; // RHB stands in the third-base-side box
  return new THREE.Vector3(side * 2.7, 0, -1.5);
}

/**
 * Build a quadratic-bezier-based curve for a pitch, bent by the pitch
 * type's stylized movement profile. Not real physics -- meant to look
 * plausibly like "this pitch breaks this way."
 */
export function buildPitchCurve(pitchCode, zone, throwsR) {
  const profile = PITCH_PROFILES[pitchCode] || PITCH_PROFILES.FF;
  const start = releasePoint(throwsR);
  const end = plateTargetPoint(zone);

  const mirror = throwsR ? 1 : -1; // mirror horizontal break for lefties
  const hBreakFt = (profile.hBreak / 12) * BREAK_EXAGGERATION * mirror;
  const vBreakFt = (profile.vBreak / 12) * BREAK_EXAGGERATION;

  const mid = start.clone().lerp(end, 0.5);
  mid.x += hBreakFt;
  mid.y += vBreakFt;

  return new THREE.QuadraticBezierCurve3(start, mid, end);
}

/** Real time-of-flight, and a slowed-down duration nicer for a UI replay. */
export function pitchDurationSeconds(pitchCode) {
  const profile = PITCH_PROFILES[pitchCode] || PITCH_PROFILES.FF;
  const ftPerSec = profile.mph * 1.4667;
  const realSeconds = RELEASE_DISTANCE_FT / ftPerSec;
  const slowFactor = 4.5;
  return Math.min(2.6, Math.max(1.1, realSeconds * slowFactor));
}
