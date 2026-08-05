import { useEffect, useState } from "react";
import { getPlayers, getTeams } from "../api";

export default function TeamPitcherSelect({ value, onChange }) {
  const [teams, setTeams] = useState([]);
  const [team, setTeam] = useState("");
  const [pitchers, setPitchers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getTeams("pitcher").then(setTeams).catch(() => setTeams([]));
  }, []);

  useEffect(() => {
    if (!team) {
      setPitchers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getPlayers("pitcher", "", team)
      .then((res) => { if (!cancelled) setPitchers(res); })
      .catch(() => { if (!cancelled) setPitchers([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [team]);

  function handleTeamChange(e) {
    setTeam(e.target.value);
    onChange(null);
  }

  function handlePitcherChange(e) {
    const id = e.target.value;
    const p = pitchers.find((x) => String(x.id) === id) || null;
    onChange(p);
  }

  return (
    <div>
      <label className="mb-1 block text-xs text-base-content/60">Pitcher</label>
      <div className="grid grid-cols-2 gap-2">
        <select
          className="select select-bordered select-sm w-full"
          value={team}
          onChange={handleTeamChange}
        >
          <option value="">Team...</option>
          {teams.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          className="select select-bordered select-sm w-full"
          value={value ? String(value.id) : ""}
          onChange={handlePitcherChange}
          disabled={!team || loading}
        >
          <option value="">
            {loading ? "Loading..." : team ? "Select pitcher..." : "Pick a team first"}
          </option>
          {pitchers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.throws})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
