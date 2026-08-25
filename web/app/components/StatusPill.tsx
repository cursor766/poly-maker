interface StatusPillProps {
  ok: boolean;
  label: string;
  neutral?: boolean;
}

export function StatusPill({ ok, label, neutral = false }: StatusPillProps) {
  const tone = neutral ? "text-amber" : ok ? "text-sage" : "text-rose";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-1.5 text-[10px] font-semibold ${tone}`}
    >
      <i className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
