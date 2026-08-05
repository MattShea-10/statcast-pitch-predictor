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
const PAD = 6;

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

// Corner zone rectangles, outside the strike zone box.
const CORNER_RECTS = {
  11: { x: 0, y: 0, w: CORNER_W, h: CORNER_H }, // Up-Away (top-left)
  12: { x: ZONE_X + ZONE_W, y: 0, w: CORNER_W, h: CORNER_H }, // Up-In (top-right)
  13: { x: 0, y: ZONE_Y + ZONE_H, w: CORNER_W, h: CORNER_H }, // Down-Away (bottom-left)
  14: { x: ZONE_X + ZONE_W, y: ZONE_Y + ZONE_H, w: CORNER_W, h: CORNER_H }, // Down-In (bottom-right)
};

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
        {/* Corner "chase" zones outside the real strike zone */}
        {Object.entries(CORNER_RECTS).map(([zone, r]) => {
          const { d, pct } = cellLabel(Number(zone));
          return (
            <g key={zone}>
              <rect
                x={r.x + PAD / 2}
                y={r.y + PAD / 2}
                width={r.w - PAD}
                height={r.h - PAD}
                rx={3}
                fill={heatColor(d ? d.probability : 0, maxP)}
                stroke="#263129"
                strokeDasharray="3,2"
                strokeWidth={1}
              >
                <title>{d ? `${d.label}: ${pct}%` : ""}</title>
              </rect>
              <text
                x={r.x + r.w / 2}
                y={r.y + r.h / 2 + 4}
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
