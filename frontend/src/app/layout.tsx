import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { Web3Provider } from "@/providers/Web3Provider";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "zstrategy — Private DeFi Trading",
  description: "Privacy-preserving DeFi trading automation using ZK proofs.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} h-full dark`}>
      <body className="min-h-full bg-background text-on-surface antialiased">
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
