interface StatusPillProps {
  ok: boolean;
  label: string;
  neutral?: boolean;
}

export function StatusPill({ ok, label, neutral = false }: StatusPillProps) {
  return (
    <span className={`statusPill ${neutral ? "neutral" : ok ? "online" : "offline"}`}>
      <i />
      {label}
    </span>
  );
}
