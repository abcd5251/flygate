"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemo } from "@/lib/store";
import { cx } from "./ui";
import { WalletButton } from "./WalletButton";

export function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="9" fill={light ? "#ffffff" : "#3264ff"} />
        <path d="M7 26V14a9 9 0 0 1 18 0v12" fill="none" stroke={light ? "#3264ff" : "#ffffff"} strokeWidth="2.4" strokeLinecap="round" />
        <path
          d="M22 18 L18 16.8 L15.8 13 L14.5 13 L15.6 16.4 L12.6 16.1 L11.8 15 L10.9 15 L11.4 18 L10.9 21 L11.8 21 L12.6 19.9 L15.6 19.6 L14.5 23 L15.8 23 L18 19.2 Z"
          fill={light ? "#3264ff" : "#ffffff"}
        />
      </svg>
      <span className={cx("text-xl font-black tracking-tight", light ? "text-white" : "text-ink")}>
        Fly<span className={light ? "text-white/80" : "text-brand"}>Gate</span>
      </span>
    </span>
  );
}

const NAV = [
  { href: "/", label: "Book" },
  { href: "/mandate", label: "Mandate" },
  { href: "/ticket", label: "Ticket" },
  { href: "/drill", label: "Breach drill" },
];

export function Header() {
  const pathname = usePathname();
  const { state } = useDemo();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-6 px-4 lg:px-8">
        <Link href="/" aria-label="FlyGate home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cx(
                "rounded-lg px-3 py-2 text-sm font-medium transition",
                pathname === n.href ? "bg-brand-50 text-brand" : "text-ink hover:bg-canvas",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {state.mode === "live" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-pass-50 px-2.5 py-1 text-xs font-bold text-pass" title="On-chain steps are sent to the QoreChain diana testnet">
              <span className="size-1.5 rounded-full bg-pass" />
              Live · diana
            </span>
          )}
          <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 sm:inline-flex">
            <span className="size-2 rounded-full bg-pass" />
            QoreChain testnet
            {state.mode !== "live" && <span className="text-muted">· demo mode</span>}
          </span>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
