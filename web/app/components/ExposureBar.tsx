interface ExposureBarProps {
  used: number;
  limit: number;
  label?: string;
}

export function ExposureBar({ used, limit, label = "账户额度" }: ExposureBarProps) {
  const uncapped = !(limit > 0);
  const ratio = uncapped ? 0 : used / limit;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  const tone = ratio > 1 ? "bg-rose" : ratio > 0.8 ? "bg-amber" : "bg-gold";
  return (
    <div>
      <div className="flex justify-between gap-3 text-xs">
        <span className="text-mute">{label}</span>
        <b className="tabular-nums">
          {uncapped ? `$${used.toFixed(2)} · 不限制` : `$${used.toFixed(2)} / $${limit.toFixed(2)}`}
        </b>
      </div>
      {!uncapped && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-inset">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
