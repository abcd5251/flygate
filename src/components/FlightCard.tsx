"use client";

import { Briefcase, Check, Sparkles, X } from "lucide-react";
import { formatShortDate, usd } from "@/lib/mandate";
import { formatDuration } from "@/lib/offers";
import type { GateVerdict, Offer } from "@/lib/types";
import { cx, Pill } from "./ui";

export function AirlineBadge({ offer, size = "md" }: { offer: Offer; size?: "md" | "lg" }) {
  return (
    <span
      className={cx("grid shrink-0 place-items-center rounded-full font-mono font-bold text-white", size === "lg" ? "size-12 text-base" : "size-10 text-sm")}
      style={{ background: offer.color }}
      aria-hidden
    >
      {offer.carrierCode}
    </span>
  );
}

type Props = {
  offer: Offer;
  verdict?: GateVerdict;
  checked: boolean;
  picked: boolean;
  pickReason?: string;
  onSelect?: () => void;
  selectLabel?: string;
  disabled?: boolean;
};

/** One result row, styled like an OTA list item, plus the gate verdict for that offer. */
export function FlightCard({ offer, verdict, checked, picked, pickReason, onSelect, selectLabel, disabled }: Props) {
  const blocked = checked && verdict && !verdict.ok;
  return (
    <article
      className={cx(
        "relative animate-fade-up overflow-hidden rounded-2xl border bg-white transition",
        picked ? "border-brand shadow-card ring-2 ring-brand/20" : "border-line",
        blocked && "bg-white/70",
      )}
    >
      {picked && (
        <div className="flex items-center gap-2 bg-brand px-5 py-1.5 text-xs font-bold text-white">
          <Sparkles className="size-3.5" /> Agent pick
          {pickReason && <span className="font-normal text-white/85">· {pickReason}</span>}
        </div>
      )}
      <div className={cx("px-5 pt-4", blocked && "opacity-55")}>
        <div className="mb-3 flex flex-wrap gap-2">
          <Pill tone="brand">
            <Briefcase className="size-3" /> {offer.baggage}
          </Pill>
          <Pill tone={offer.refundable ? "pass" : "warn"}>{offer.refundable ? "Refundable" : "Non-refundable"}</Pill>
          {offer.testAirline && <Pill tone="pq">Duffel test airline</Pill>}
          <Pill>{formatShortDate(offer.date)}</Pill>
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 pb-4 md:grid-cols-[180px_1fr_auto]">
          <div className="flex items-center gap-3">
            <AirlineBadge offer={offer} />
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">{offer.carrier}</p>
              <p className="font-mono text-xs text-muted">{offer.flightNo}</p>
            </div>
          </div>
          <div className="col-span-2 grid grid-cols-[auto_1fr_auto] items-center gap-3 md:col-span-1">
            <div className="text-center">
              <p className="tabular text-2xl font-bold text-ink">{offer.depart}</p>
              <p className="text-xs text-muted">
                {offer.from} {offer.fromTerminal}
              </p>
            </div>
            <div className="text-center text-xs text-muted">
              <p>{formatDuration(offer.durationMin)}</p>
              <div className="my-1 flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-line" />
                <span className="h-px flex-1 bg-line" />
                {offer.stops > 0 && <span className="size-1.5 rounded-full bg-warn" />}
                {offer.stops > 0 && <span className="h-px flex-1 bg-line" />}
                <span className="size-1.5 rounded-full bg-line" />
              </div>
              <p>{offer.stops === 0 ? "Nonstop" : `1 stop · ${offer.via}`}</p>
            </div>
            <div className="text-center">
              <p className="tabular text-2xl font-bold text-ink">{offer.arrive}</p>
              <p className="text-xs text-muted">
                {offer.to} {offer.toTerminal}
              </p>
            </div>
          </div>
          <div className="col-span-2 flex items-center justify-between gap-4 md:col-span-1 md:justify-end">
            <div className="text-right">
              <p className="tabular text-2xl font-bold text-brand">{usd(offer.priceUsd)}</p>
              <p className="text-xs text-muted">One-way · incl. tax</p>
            </div>
            {onSelect && (
              <button
                type="button"
                onClick={onSelect}
                disabled={disabled || blocked || !checked}
                className={cx(
                  "min-w-24 rounded-xl px-5 py-3 text-sm font-bold transition",
                  picked ? "bg-brand text-white hover:bg-brand-600" : "border border-brand text-brand hover:bg-brand-50",
                  "disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-muted",
                )}
              >
                {blocked ? "Blocked" : selectLabel ?? "Select"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className={cx("flex flex-wrap items-center gap-2 border-t px-5 py-2.5 text-xs", blocked ? "border-block/20 bg-block-50" : "border-line bg-canvas/70")}>
        <span className={cx("font-bold", !checked ? "text-muted" : blocked ? "text-block" : "text-pass")}>
          {!checked ? "Gate checking…" : blocked ? `Blocked: ${verdict?.firstFail?.detail}` : "Passed the gate"}
        </span>
        {checked &&
          verdict?.checks.map((c) => (
            <span
              key={c.key}
              className={cx(
                "inline-flex animate-pop items-center gap-1 rounded-full px-2 py-0.5",
                c.ok ? "bg-white text-pass" : "bg-white text-block",
              )}
              title={c.detail}
            >
              {c.ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
              {c.label}
            </span>
          ))}
      </div>
    </article>
  );
}
