"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "配置" },
  { href: "/signal", label: "信号" },
  { href: "/dashboard", label: "交易台" },
] as const;

export function TopNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-raised/90 px-[max(24px,calc((100vw-1200px)/2))] backdrop-blur-md">
      <Link className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight" href="/">
        <span className="grid size-[22px] place-items-center rounded-md border border-line-strong text-xs font-semibold text-gold">
          P
        </span>
        <span>
          Poly Maker
          <small className="mt-px block text-[11px] font-medium text-mute">
            King Pro League desk
          </small>
        </span>
      </Link>
      <nav className="flex h-14 items-stretch gap-1">
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link
              className={`grid place-items-center border-b-2 px-3.5 text-[13px] font-medium ${
                active
                  ? "border-gold text-ink"
                  : "border-transparent text-mute hover:text-ink"
              }`}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
