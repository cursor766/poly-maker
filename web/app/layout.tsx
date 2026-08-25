import type { Metadata } from "next";
import { Instrument_Sans, Noto_Sans_SC } from "next/font/google";
import type { ReactNode } from "react";
import { TopNav } from "./components/TopNav";
import "./globals.css";

const sans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const cjk = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-cjk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Poly Maker",
  description: "王者荣耀 KPL / KGL Polymarket 做市控制台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${sans.variable} ${cjk.variable}`} lang="zh-CN">
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased [font-feature-settings:'tnum'_1]">
        <TopNav />
        <main className="mx-auto w-[min(1200px,calc(100%-48px))] py-7 pb-20">{children}</main>
      </body>
    </html>
  );
}
