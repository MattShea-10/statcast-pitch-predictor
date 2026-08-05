export default function BaseRunners({ on1b, on2b, on3b, onToggle }) {
  const pill = (active) =>
    `btn btn-xs flex-1 ${active ? "btn-primary" : "btn-outline"}`;

  return (
    <div>
      <label className="mb-1.5 block text-xs uppercase tracking-wide text-base-content/60">Runners on</label>
      <div className="flex gap-1.5">
        <button type="button" className={pill(on1b)} onClick={() => onToggle("on_1b")}>1B</button>
        <button type="button" className={pill(on2b)} onClick={() => onToggle("on_2b")}>2B</button>
        <button type="button" className={pill(on3b)} onClick={() => onToggle("on_3b")}>3B</button>
      </div>
    </div>
  );
}
