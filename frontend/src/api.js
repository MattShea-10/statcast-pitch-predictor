// In dev, Vite proxies /api to the local backend (see vite.config.js). In
// production (Vercel), set VITE_API_URL to the deployed backend's base URL
// (e.g. https://statcast-pitch-predictor-api.onrender.com), and requests go
// straight there instead of through a same-origin proxy.
const BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : "/api";

export async function getHealth() {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error("health check failed");
  return res.json();
}

export async function getPlayers(role, q = "", team = "") {
  const params = new URLSearchParams({ role });
  if (q) params.set("q", q);
  if (team) params.set("team", team);
  const res = await fetch(`${BASE}/players?${params.toString()}`);
  if (!res.ok) throw new Error("failed to load players");
  return res.json();
}

export async function getTeams(role) {
  const params = new URLSearchParams();
  if (role) params.set("role", role);
  const res = await fetch(`${BASE}/teams?${params.toString()}`);
  if (!res.ok) throw new Error("failed to load teams");
  return res.json();
}

export async function predictNextPitch(payload) {
  const res = await fetch(`${BASE}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `predict failed (${res.status})`);
  }
  return res.json();
}

// Checks a batch of previously-tracked predictions against the real pitches
// actually thrown -- meant to be called after fresher data has been pulled
// (e.g. the next morning), once the games being watched have been processed.
export async function verifyPredictions(predictions) {
  const res = await fetch(`${BASE}/verify_predictions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ predictions }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `verify failed (${res.status})`);
  }
  return res.json();
}
