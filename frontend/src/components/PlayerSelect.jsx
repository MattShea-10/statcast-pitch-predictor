import { useEffect, useRef, useState } from "react";
import { getPlayers } from "../api";

export default function PlayerSelect({ role, label, value, onChange }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPlayers(role, query)
      .then((res) => { if (!cancelled) setOptions(res); })
      .catch(() => { if (!cancelled) setOptions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [role, query]);

  useEffect(() => {
    function handleClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="dropdown w-full" ref={boxRef}>
      <label className="mb-1 block text-xs text-base-content/60">{label}</label>
      <div className="relative flex items-center">
        <input
          type="text"
          className="input input-bordered input-sm w-full pr-12"
          placeholder={`Search ${role}s...`}
          value={open ? query : (value ? value.name : query)}
          onFocus={() => { setOpen(true); setQuery(""); }}
          onChange={(e) => setQuery(e.target.value)}
        />
        {value && !open && (
          <span className={`badge badge-sm absolute right-2 ${role === "pitcher" ? "badge-secondary" : "badge-primary"}`}>
            {role === "pitcher" ? value.throws : value.stand}
          </span>
        )}
      </div>
      {open && (
        <ul className="menu dropdown-content menu-sm z-10 mt-1 max-h-56 w-full flex-nowrap overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
          {loading && <li className="px-2.5 py-2 text-xs text-base-content/40">Loading...</li>}
          {!loading && options.length === 0 && (
            <li className="px-2.5 py-2 text-xs text-base-content/40">No matches. Run the data pipeline first?</li>
          )}
          {!loading && options.map((p) => (
            <li key={p.id}>
              <a
                className="flex justify-between text-sm"
                onClick={() => { onChange(p); setOpen(false); setQuery(""); }}
              >
                {p.name}
                <span className="text-xs text-base-content/40">{role === "pitcher" ? p.throws : p.stand}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
