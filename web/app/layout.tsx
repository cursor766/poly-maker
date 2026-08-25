import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Poly Maker Control",
  description: "Polymarket 做市控制面板",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="topbar">
          <Link className="brand" href="/">
            <span className="brandMark">PM</span>
            <span>
              Poly Maker
              <small>CONTROL DESK</small>
            </span>
          </Link>
          <nav>
            <Link href="/">市场配置</Link>
            <Link href="/signal">信号吃单</Link>
            <Link href="/dashboard">运行看板</Link>
          </nav>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
