"use client";

import Link from "next/link";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { formatExpiry, formatRange, usd } from "@/lib/mandate";
import { useDemo } from "@/lib/store";
import { cx } from "./ui";

/** Always-visible summary of the signed mandate, so the gate stays on screen during the whole flow. */
export function GateBar() {
  const { state } = useDemo();
  const { signed, draft: m, spentUsd, revoked } = state;
  if (!signed) return null;
  const pct = Math.min(100, Math.round((spentUsd / m.maxFareUsd) * 100));

  return (
    <div className={cx("border-b", revoked ? "border-block/20 bg-block-50" : "border-line bg-white")}>
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 text-xs lg:px-8">
        <span className={cx("inline-flex items-center gap-1.5 font-bold", revoked ? "text-block" : "text-pass")}>
          {revoked ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
          {revoked ? "Agent revoked" : "Mandate active"}
        </span>
        <span className="text-ink">
          {m.origin.code} → {m.destination.city}
          <span className="text-muted"> · {formatRange(m.departFrom, m.departTo)}</span>
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="text-muted">Spent</span>
          <span className="tabular font-bold text-ink">{usd(spentUsd)}</span>
          <span className="h-1.5 w-24 overflow-hidden rounded-full bg-canvas">
            <span className="block h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </span>
          <span className="tabular text-muted">of {usd(m.maxFareUsd)}</span>
        </span>
        <span className="text-muted">
          Expires <span className="tabular text-ink">{formatExpiry(m.expiresAt)}</span>
        </span>
        <Link href="/drill" className="ml-auto font-medium text-brand hover:underline">
          What if the agent key leaks?
        </Link>
      </div>
    </div>
  );
}
