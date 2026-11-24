import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { GateBar } from "@/components/GateBar";
import { Header } from "@/components/Header";
import { PresenterPanel } from "@/components/PresenterPanel";
import { DemoProvider } from "@/lib/store";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "700", "800", "900"],
});

const mono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "FlyGate · AI books your flight, the gate guards your money",
  description: "An AI agent books your flight. On-chain rules and post-quantum signatures cap every dollar it spends.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <DemoProvider>
          <Header />
          <GateBar />
          <div className="flex-1">{children}</div>
          <PresenterPanel />
        </DemoProvider>
      </body>
    </html>
  );
}
