import { Plane } from "lucide-react";
import { CABIN_LABEL, formatExpiry, formatRange, usd } from "@/lib/mandate";
import type { Mandate } from "@/lib/types";
import { HashText } from "./ui";

/** The mandate drawn as a boarding pass: what the agent is allowed to do, at a glance. */
export function BoardingPass({ m, hash, signedLabel }: { m: Mandate; hash?: string; signedLabel?: string }) {
  const fields = [
    { k: "Traveler", v: `${m.passengers} adult` },
    { k: "Cabin", v: CABIN_LABEL[m.cabin] },
    { k: "Max fare", v: usd(m.maxFareUsd) },
    { k: "Departs", v: formatRange(m.departFrom, m.departTo) },
    { k: "Fare type", v: m.refundableOnly ? "Refundable" : "Any" },
    { k: "Expires", v: formatExpiry(m.expiresAt) },
  ];

  return (
    <div className="grid overflow-hidden rounded-2xl border border-line bg-white shadow-card md:grid-cols-[1fr_220px]">
      <div className="space-y-5 p-6">
        <div className="flex items-center justify-between text-xs font-bold tracking-[0.14em] text-muted uppercase">
          <span>
            <span className="text-brand">Flight Mandate</span>
          </span>
          <span>{signedLabel ?? "Not signed"}</span>
        </div>
        <div className="flex items-center gap-4">
          <div>
            <p className="font-mono text-5xl font-semibold text-ink">{m.origin.code}</p>
            <p className="text-sm text-muted">{m.origin.city}</p>
          </div>
          <div className="flex flex-1 items-center gap-2 text-brand" aria-hidden>
            <span className="flex-1 border-t-2 border-dashed border-line" />
            <Plane className="size-6" />
            <span className="flex-1 border-t-2 border-dashed border-line" />
          </div>
          <div className="text-right">
            <p className="font-mono text-5xl font-semibold text-ink">{m.destination.code}</p>
            <p className="text-sm text-muted">
              {m.destination.city} · {m.destination.airports.join("/")}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {fields.map((f) => (
            <div key={f.k}>
              <dt className="text-[11px] font-bold tracking-[0.12em] text-muted uppercase">{f.k}</dt>
              <dd className="tabular font-bold text-ink">{f.v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="pass-notch flex flex-col justify-center gap-3 border-t-2 border-dashed border-line bg-brand-50/60 p-6 md:border-t-0 md:border-l-2">
        <p className="text-[11px] font-bold tracking-[0.12em] text-muted uppercase">Mandate hash</p>
        {hash ? <HashText value={hash} head={12} tail={8} className="text-sm" /> : <p className="text-sm text-muted">Created when you sign</p>}
        <p className="text-[11px] font-bold tracking-[0.12em] text-muted uppercase">Signature</p>
        <p className="text-sm font-bold text-pq">ML-DSA-87</p>
      </div>
    </div>
  );
}
