// Statcast zone numbering (catcher's view): 1-9 form the 3x3 strike zone,
// 11/12/13/14 are the four out-of-zone corners.
//
// Layout is drawn to the real strike zone's proportions -- 17in home plate
// width by ~2ft of vertical zone (the same 1.417 x 2 box used for the 3D
// strike zone), with the four "chase" corner zones sized and placed outside
// that rectangle instead of as uniform grid squares.
const ZONE_W = 120;
const ZONE_H = Math.round(ZONE_W / 0.7085); // real strike-zone aspect ratio
const CORNER_W = 42;
const CORNER_H = 46;

const W = ZONE_W + CORNER_W * 2;
const H = ZONE_H + CORNER_H * 2;
const ZONE_X = CORNER_W;
const ZONE_Y = CORNER_H;
const CELL_W = ZONE_W / 3;
const CELL_H = ZONE_H / 3;

// Row/col 0-2 within the 3x3 in-zone grid.
const IN_ZONE_CELLS = {
  1: [0, 0], 2: [0, 1], 3: [0, 2],
  4: [1, 0], 5: [1, 1], 6: [1, 2],
  7: [2, 0], 8: [2, 1], 9: [2, 2],
};

// Statcast only tracks 4 out-of-zone buckets total (one per quadrant), not a
// finer grid -- so there's no real data for the strip directly above, below,
// or beside the zone. Rather than leave those strips blank, each corner
// quadrant is drawn as an L-shaped polygon covering its whole quarter of the
// ring around the strike zone (split at the zone's own center lines), so the
// same 4 real percentages cover the full perimeter with no gaps, instead of
// only appearing in small squares at the literal corners.
const MID_X = W / 2;
const MID_Y = H / 2;
const CORNER_POLYGONS = {
  // Up-Away (top-left): outer top-left quadrant, notched where the strike
  // zone itself intrudes into that quadrant.
  11: [[0, 0], [MID_X, 0], [MID_X, ZONE_Y], [ZONE_X, ZONE_Y], [ZONE_X, MID_Y], [0, MID_Y]],
  // Up-In (top-right)
  12: [[W, 0], [MID_X, 0], [MID_X, ZONE_Y], [ZONE_X + ZONE_W, ZONE_Y], [ZONE_X + ZONE_W, MID_Y], [W, MID_Y]],
  // Down-Away (bottom-left)
  13: [[0, H], [MID_X, H], [MID_X, ZONE_Y + ZONE_H], [ZONE_X, ZONE_Y + ZONE_H], [ZONE_X, MID_Y], [0, MID_Y]],
  // Down-In (bottom-right)
  14: [[W, H], [MID_X, H], [MID_X, ZONE_Y + ZONE_H], [ZONE_X + ZONE_W, ZONE_Y + ZONE_H], [ZONE_X + ZONE_W, MID_Y], [W, MID_Y]],
};
// Label position for each quadrant -- the visual "weight center" of the
// L-shape (roughly between its outer corner and the zone edge), not a true
// centroid, so the percentage sits in open space rather than near the notch.
const CORNER_LABEL_POS = {
  11: [MID_X * 0.45, MID_Y * 0.45],
  12: [W - (W - MID_X) * 0.45, MID_Y * 0.45],
  13: [MID_X * 0.45, H - (H - MID_Y) * 0.45],
  14: [W - (W - MID_X) * 0.45, H - (H - MID_Y) * 0.45],
};

// The color fill is continuous around the ring now, but directly
// above/below/beside the zone is a seam between two different corner
// buckets (e.g. 11 and 12 meet at top-middle) and each one's own label sits
// off to its own side -- so there's no number actually sitting at "middle
// above" itself. These add one extra label at each of those 4 midpoints,
// the average of the two real buckets that meet there (a blended readout,
// not a 5th real data point) so there's something to read where the eye
// naturally lands.
const EDGE_MID_LABELS = [
  { key: "top", x: MID_X, y: CORNER_H * 0.5, zones: [11, 12] },
  { key: "bottom", x: MID_X, y: H - CORNER_H * 0.5, zones: [13, 14] },
  { key: "left", x: CORNER_W * 0.5, y: MID_Y, zones: [11, 13] },
  { key: "right", x: W - CORNER_W * 0.5, y: MID_Y, zones: [12, 14] },
];

function heatColor(p, maxP) {
  const t = maxP > 0 ? Math.min(1, p / maxP) : 0;
  // interpolate from dark panel tone (cold) to red accent (hot)
  const r = Math.round(24 + t * (214 - 24));
  const g = Math.round(35 + t * (69 - 35));
  const b = Math.round(30 + t * (60 - 30));
  return `rgb(${r}, ${g}, ${b})`;
}

export default function StrikeZoneHeatmap({ data }) {
  if (!data || data.length === 0) return null;
  const maxP = Math.max(...data.map((d) => d.probability));
  const byZone = Object.fromEntries(data.map((d) => [d.zone, d]));

  function cellLabel(zone) {
    const d = byZone[zone];
    const pct = d ? Math.round(d.probability * 1000) / 10 : 0;
    return { d, pct };
  }

  // The 4 out-of-zone corner buckets each cover a much bigger physical area
  // than any single in-zone cell, so they tend to win "most likely single
  // spot" even when the pitch is about as likely to be a strike overall.
  // Surface the honest in-zone-vs-out-of-zone split, plus the single most
  // likely spot specifically among the 9 in-zone cells, so "where does it
  // go if it's a strike" is still easy to read at a glance.
  const strikePct = Math.round(
    data.filter((d) => d.zone <= 9).reduce((sum, d) => sum + d.probability, 0) * 1000
  ) / 10;
  const ballPct = Math.round((100 - strikePct) * 10) / 10;

  const inZoneEntries = data.filter((d) => d.zone <= 9);
  const bestInZone = inZoneEntries.length
    ? inZoneEntries.reduce((a, b) => (b.probability > a.probability ? b : a))
    : null;
  const bestInZonePct = bestInZone ? Math.round(bestInZone.probability * 1000) / 10 : 0;

  return (
    <div className="flex flex-col items-center">
      <div className="mb-2 flex w-full items-center justify-center gap-3 text-[11px]">
        <span className="text-base-content/70">
          <span className="font-semibold text-success">{strikePct}%</span> in zone
        </span>
        <span className="text-base-content/25">·</span>
        <span className="text-base-content/70">
          <span className="font-semibold text-error">{ballPct}%</span> out of zone
        </span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Out-of-zone "chase" regions ringing the real strike zone. Statcast
            only tracks 4 out-of-zone buckets (one per quadrant), so there's
            no separate real number for e.g. "high middle" vs "high left" --
            both are part of the same Up-Away bucket and show the same
            percentage. Each bucket's polygon is stretched to fill its whole
            quarter of the ring so the color/percentage reads as continuous
            coverage around the zone instead of stopping at the corners. */}
        {Object.entries(CORNER_POLYGONS).map(([zone, points]) => {
          const { d, pct } = cellLabel(Number(zone));
          const [lx, ly] = CORNER_LABEL_POS[zone];
          return (
            <g key={zone}>
              <polygon
                points={points.map(([x, y]) => `${x},${y}`).join(" ")}
                fill={heatColor(d ? d.probability : 0, maxP)}
                stroke="#263129"
                strokeDasharray="3,2"
                strokeWidth={1}
              >
                <title>{d ? `${d.label}: ${pct}%` : ""}</title>
              </polygon>
              <text
                x={lx}
                y={ly + 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="#c7d3c9"
              >
                {pct}%
              </text>
            </g>
          );
        })}

        {/* Blended readout at the 4 seams where two corner buckets meet
            (directly above/below/beside the zone) -- see EDGE_MID_LABELS. */}
        {EDGE_MID_LABELS.map(({ key, x, y, zones: [zA, zB] }) => {
          const dA = byZone[zA];
          const dB = byZone[zB];
          const pct = Math.round(
            (((dA ? dA.probability : 0) + (dB ? dB.probability : 0)) / 2) * 1000
          ) / 10;
          return (
            <text
              key={key}
              x={x}
              y={y + 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="#c7d3c9"
            >
              {pct}%
            </text>
          );
        })}

        {/* Real strike zone rectangle, to home-plate proportions */}
        <rect
          x={ZONE_X}
          y={ZONE_Y}
          width={ZONE_W}
          height={ZONE_H}
          fill="none"
          stroke="#c7d3c9"
          strokeWidth={2}
        />

        {/* 3x3 grid inside the real strike zone */}
        {Object.entries(IN_ZONE_CELLS).map(([zone, [row, col]]) => {
          const { d, pct } = cellLabel(Number(zone));
          const x = ZONE_X + col * CELL_W;
          const y = ZONE_Y + row * CELL_H;
          const isBestStrike = bestInZone && Number(zone) === bestInZone.zone;
          return (
            <g key={zone}>
              <rect
                x={x + 1}
                y={y + 1}
                width={CELL_W - 2}
                height={CELL_H - 2}
                fill={heatColor(d ? d.probability : 0, maxP)}
                stroke={isBestStrike ? "#e0b73a" : "#0b100d"}
                strokeWidth={isBestStrike ? 2.5 : 1}
              >
                <title>{d ? `${d.label}: ${pct}%` : ""}</title>
              </rect>
              <text
                x={x + CELL_W / 2}
                y={y + CELL_H / 2 + 4}
                textAnchor="middle"
                fontSize={12}
                fontWeight={700}
                fill="#f0f0ea"
              >
                {pct}%
              </text>
            </g>
          );
        })}

        {/* Home plate, drawn below the zone for a catcher's-eye reference */}
        <polygon
          points={`
            ${ZONE_X + ZONE_W * 0.18},${H - 4}
            ${ZONE_X + ZONE_W * 0.82},${H - 4}
            ${ZONE_X + ZONE_W * 0.82},${H - 14}
            ${ZONE_X + ZONE_W * 0.5},${H - 22}
            ${ZONE_X + ZONE_W * 0.18},${H - 14}
          `}
          fill="#e6e6e0"
          opacity={0.85}
        />
      </svg>
      <p className="mt-2 text-center text-[11px] text-base-content/40">
        {bestInZone && (
          <>
            <span className="text-base-content/60">Most likely if it's a strike: </span>
            <span className="font-semibold" style={{ color: "#e0b73a" }}>
              {bestInZone.label} ({bestInZonePct}%)
            </span>
            <br />
          </>
        )}
        Catcher's-eye view, drawn to real strike-zone proportions.
      </p>
    </div>
  );
}
