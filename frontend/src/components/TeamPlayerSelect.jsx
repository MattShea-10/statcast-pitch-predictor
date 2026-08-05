import { useEffect, useState } from "react";
import { getPlayers, getTeams } from "../api";

export default function TeamPlayerSelect({ role, label, value, onChange }) {
  const [teams, setTeams] = useState([]);
  const [team, setTeam] = useState("");
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getTeams(role).then(setTeams).catch(() => setTeams([]));
  }, [role]);

  // If a value shows up from outside (e.g. restored from a saved session on
  // page load) whose team isn't the one currently selected here, catch the
  // local team dropdown up to match -- otherwise the team select would show
  // blank even though a specific player from that team is already chosen.
  useEffect(() => {
    if (value?.team && value.team !== team) {
      setTeam(value.team);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!team) {
      setPlayers([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getPlayers(role, "", team)
      .then((res) => { if (!cancelled) setPlayers(res); })
      .catch(() => { if (!cancelled) setPlayers([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [role, team]);

  function handleTeamChange(e) {
    setTeam(e.target.value);
    onChange(null);
  }

  function handlePlayerChange(e) {
    const id = e.target.value;
    const p = players.find((x) => String(x.id) === id) || null;
    onChange(p);
  }

  const handednessKey = role === "pitcher" ? "throws" : "stand";

  return (
    <div>
      <label className="mb-1 block text-xs text-base-content/60">{label}</label>
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
          onChange={handlePlayerChange}
          disabled={!team || loading}
        >
          <option value="">
            {loading ? "Loading..." : team ? `Select ${role}...` : "Pick a team first"}
          </option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.last_lineup_slot ? `${p.last_lineup_slot}. ` : ""}
              {p.name} ({p[handednessKey]})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
