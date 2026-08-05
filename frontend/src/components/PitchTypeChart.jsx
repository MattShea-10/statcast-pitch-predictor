import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from "recharts";

const COLORS = ["#d6453c", "#c98a3a", "#e0b73a", "#4f8f5f", "#2e63b8", "#7d5ba6", "#8a9a8d", "#5a655d"];

function PitchTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="border border-base-300 bg-base-200 px-3 py-2 text-xs text-base-content/80">
      <div className="font-semibold text-base-content">{d.fullName}</div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-base-content/60">
        {d.avgMph != null && <span>{d.avgMph.toFixed(1)} mph</span>}
        {d.avgMph != null && <span className="text-base-content/30">·</span>}
        <span>{d.probability}% likely</span>
      </div>
    </div>
  );
}

export default function PitchTypeChart({ data, selected, onSelect }) {
  if (!data || data.length === 0) return null;
  const chartData = data.map((d) => ({
    name: d.code,
    fullName: d.name,
    probability: Math.round(d.probability * 1000) / 10,
    avgMph: d.avg_mph,
  }));

  return (
    <div className="w-full">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#263129" />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#8a9a8d" }} axisLine={{ stroke: "#263129" }} tickLine={false} />
          <YAxis unit="%" tick={{ fontSize: 10, fill: "#8a9a8d" }} axisLine={{ stroke: "#263129" }} tickLine={false} />
          <Tooltip cursor={{ fill: "rgba(199, 211, 201, 0.06)" }} content={<PitchTooltip />} />
          <Bar
            dataKey="probability"
            radius={[3, 3, 0, 0]}
            cursor="pointer"
            onClick={(d) => onSelect?.(d.name)}
          >
            {chartData.map((d, i) => (
              <Cell
                key={i}
                fill={COLORS[i % COLORS.length]}
                opacity={!selected || d.name === selected ? 1 : 0.35}
                stroke={d.name === selected ? "#f0f0ea" : "none"}
                strokeWidth={d.name === selected ? 1.5 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-1 text-[10px] text-base-content/40">Click a bar to see where that pitch tends to go.</p>
    </div>
  );
}
