import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { TopNav } from "./components/TopNav";
import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Poly Maker",
  description: "王者荣耀 KPL / KGL Polymarket 做市控制台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${sans.variable} ${mono.variable}`} lang="zh-CN">
      <body>
        <TopNav />
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
