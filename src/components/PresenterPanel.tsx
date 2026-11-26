"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MonitorPlay, RotateCcw, X } from "lucide-react";
import { liveChain, type ChainStatus } from "@/lib/chain";
import { useDemo } from "@/lib/store";
import type { DemoMode, Scenario } from "@/lib/types";
import { cx } from "./ui";

const SCENARIOS: Array<{ key: Scenario; label: string; hint: string }> = [
  { key: "normal", label: "Ticketed", hint: "Quote passes, ticket issued, payout" },
  { key: "price_change", label: "Fare jumps", hint: "Quote rises to US$428, gate blocks it" },
  { key: "order_fail", label: "Booking fails", hint: "Duffel fails after escrow, auto refund" },
];

const MODES: Array<{ key: DemoMode; label: string }> = [
  { key: "simulated", label: "Simulated" },
  { key: "live", label: "Live" },
];

const JUMPS = [
  { href: "/", label: "1 Trip" },
  { href: "/mandate", label: "2 Sign" },
  { href: "/search", label: "3 Agent search" },
  { href: "/checkout", label: "4 Gate check" },
  { href: "/ticket", label: "5 Ticket" },
  { href: "/drill", label: "6 Breach drill" },
];

/** Floating control panel for whoever presents the demo. Toggle with the D key. */
export function PresenterPanel() {
  const { state, update, reset, signing } = useDemo();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<ChainStatus | undefined>();

  // Ask the server whether Live can run each time the panel opens (the server caches 30 s).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    liveChain.status().then((st) => {
      if (!cancelled) setLive(st);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const bookingRunning = state.booking?.status === "running";
  const modeLocked = bookingRunning || signing;
  const liveSelectable = live?.available === true;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "d" || e.key === "D") setOpen((o) => !o);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-80 animate-fade-up rounded-2xl border border-line bg-white p-4 shadow-float" role="dialog" aria-label="Demo controls">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-bold text-ink">Demo controls</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-muted hover:text-ink">
              <X className="size-4" />
            </button>
          </div>

          <p className="mb-2 text-xs font-bold tracking-wide text-muted">Chain</p>
          <div className="mb-4">
            <div className="grid grid-cols-2 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="Chain mode">
              {MODES.map((md) => {
                const disabled = modeLocked || (md.key === "live" && !liveSelectable && state.mode !== "live");
                return (
                  <button
                    key={md.key}
                    type="button"
                    role="radio"
                    aria-checked={state.mode === md.key}
                    disabled={disabled}
                    onClick={() => update((st) => ({ ...st, mode: md.key }))}
                    className={cx(
                      "rounded-md px-3 py-1 text-xs font-bold disabled:cursor-not-allowed",
                      state.mode === md.key ? "bg-brand text-white" : "text-ink-2 disabled:text-muted/60",
                    )}
                  >
                    {md.label}
                  </button>
                );
              })}
            </div>
            {modeLocked ? (
              <p className="mt-1.5 text-[11px] text-muted">
                Locked while {bookingRunning ? "a booking is running" : "the signing window is open"}.
              </p>
            ) : !live ? (
              <p className="mt-1.5 text-[11px] text-muted">Checking Live…</p>
            ) : live.available ? (
              <p className="mt-1.5 text-[11px] text-pass">Live ready on diana.</p>
            ) : (
              <p className="mt-1.5 text-[11px] text-block">Live unavailable: {live.reason}</p>
            )}
          </div>

          <p className="mb-2 text-xs font-bold tracking-wide text-muted">Next booking scenario</p>
          <div className="space-y-1.5">
            {SCENARIOS.map((s) => (
              <label
                key={s.key}
                className={cx(
                  "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                  state.scenario === s.key ? "border-brand bg-brand-50" : "border-line hover:bg-canvas",
                )}
              >
                <input
                  type="radio"
                  name="scenario"
                  className="mt-1 accent-brand"
                  checked={state.scenario === s.key}
                  onChange={() => update((st) => ({ ...st, scenario: s.key }))}
                />
                <span>
                  <span className="font-medium text-ink">{s.label}</span>
                  <span className="block text-xs text-muted">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-xs font-bold tracking-wide text-muted">Speed</span>
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {([1, 2] as const).map((sp) => (
                <button
                  key={sp}
                  type="button"
                  onClick={() => update((st) => ({ ...st, speed: sp }))}
                  className={cx("rounded-md px-3 py-1 text-xs font-bold", state.speed === sp ? "bg-brand text-white" : "text-ink-2")}
                >
                  {sp}×
                </button>
              ))}
            </div>
          </div>

          <p className="mt-4 mb-2 text-xs font-bold tracking-wide text-muted">Jump to</p>
          <div className="grid grid-cols-2 gap-1.5">
            {JUMPS.map((j) => (
              <Link key={j.href} href={j.href} className="rounded-lg bg-canvas px-2 py-1.5 text-xs text-ink hover:bg-brand-50 hover:text-brand">
                {j.label}
              </Link>
            ))}
          </div>

          <button
            type="button"
            onClick={() => {
              reset();
              router.push("/");
            }}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-block/30 py-2 text-sm font-bold text-block hover:bg-block-50"
          >
            <RotateCcw className="size-4" /> Reset demo
          </button>
          <p className="mt-2 text-center text-[11px] text-muted">Press D to toggle</p>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Demo controls"
        className="grid size-14 place-items-center rounded-full bg-brand text-white shadow-float ring-4 ring-white transition hover:bg-brand-600"
      >
        <MonitorPlay className="size-6" />
      </button>
    </div>
  );
}
