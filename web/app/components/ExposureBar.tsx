interface ExposureBarProps {
  used: number;
  limit: number;
  label?: string;
}

export function ExposureBar({ used, limit, label = "账户额度" }: ExposureBarProps) {
  const ratio = limit > 0 ? used / limit : 0;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  const tone = ratio > 1 ? "danger" : ratio > 0.8 ? "warning" : "safe";
  return (
    <div className="exposure">
      <div className="exposureHead">
        <span>{label}</span>
        <b>
          ${used.toFixed(2)} / ${limit.toFixed(2)}
        </b>
      </div>
      <div className="exposureTrack">
        <div className={`exposureFill ${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
