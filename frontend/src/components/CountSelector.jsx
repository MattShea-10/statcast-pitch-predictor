const circle =
  "h-7 w-7 rounded-full border text-xs font-semibold transition-colors flex items-center justify-center";
const idleCircle = "border-base-300 bg-base-200 text-base-content/70 hover:bg-base-300";

export default function CountSelector({ balls, strikes, onChange }) {
  return (
    <div className="col-span-2">
      <label className="mb-1.5 block text-xs uppercase tracking-wide text-base-content/60">Count</label>
      <div className="flex items-center gap-1.5">
        {[0, 1, 2, 3].map((b) => (
          <button
            key={`b${b}`}
            type="button"
            className={`${circle} ${b === balls ? "border-accent bg-accent text-accent-content" : idleCircle}`}
            onClick={() => onChange(b, strikes)}
          >
            {b}
          </button>
        ))}
        <span className="mx-1 text-base-content/40">&ndash;</span>
        {[0, 1, 2].map((s) => (
          <button
            key={`s${s}`}
            type="button"
            className={`${circle} ${s === strikes ? "border-primary bg-primary text-primary-content" : idleCircle}`}
            onClick={() => onChange(balls, s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
