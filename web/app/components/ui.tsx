import type { ButtonHTMLAttributes, ReactNode } from "react";

const variants = {
  primary:
    "inline-flex h-10 items-center justify-center rounded-lg bg-gold px-4 text-[13px] font-semibold text-on-gold transition-colors hover:bg-gold-hover disabled:pointer-events-none",
  secondary:
    "inline-flex h-10 items-center justify-center rounded-lg border border-line bg-transparent px-4 text-[13px] font-semibold text-ink transition-colors hover:border-line-strong hover:bg-inset disabled:pointer-events-none",
  danger:
    "inline-flex h-10 items-center justify-center rounded-lg border border-rose/40 bg-transparent px-4 text-[13px] font-semibold text-rose transition-colors hover:bg-rose/10 disabled:pointer-events-none",
  ghost:
    "inline-flex h-8 items-center justify-center rounded-md border border-line bg-transparent px-2.5 text-[11px] font-medium text-mute transition-colors hover:border-line-strong hover:text-ink disabled:pointer-events-none",
} as const;

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants }) {
  return <button className={`${variants[variant]} ${className}`} type={type} {...props} />;
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-xs font-medium text-mute" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

export const inputClass =
  "h-10 w-full rounded-lg border border-line bg-inset px-3 text-[13px] text-ink outline-none focus:border-line-strong";

export const panelClass = "rounded-[10px] border border-line bg-panel p-5";

export const errorClass =
  "mt-3 rounded-lg border border-rose/20 bg-rose/10 px-3.5 py-3 text-[13px] text-rose";

export const successClass =
  "mt-3 rounded-lg border border-gold/20 bg-gold/10 px-3.5 py-3 text-[13px] text-gold";
