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
    <header className="topbar">
      <Link className="brand" href="/">
        <span className="brandMark">PM</span>
        <span>
          Poly Maker
          <small>HONOR OF KINGS DESK</small>
        </span>
      </Link>
      <nav>
        {links.map((link) => {
          const active = pathname === link.href;
          return (
            <Link className={active ? "active" : undefined} href={link.href} key={link.href}>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
