"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Siren } from "lucide-react";
import { AirlineBadge } from "@/components/FlightCard";
import { EmptyState, FlowBand } from "@/components/FlowBand";
import { Card, cx, HashText, SourceTag } from "@/components/ui";
import { CABIN_LABEL, formatDateLong, usd } from "@/lib/mandate";
import { DEMO_OFFERS, formatDuration } from "@/lib/offers";
import { useDemo } from "@/lib/store";

export default function TicketPage() {
  const { state, ready } = useDemo();
  const booking = state.booking;
  const offer = DEMO_OFFERS.find((o) => o.id === booking?.offerId);

  if (!ready) return null;
  if (!booking || booking.status !== "succeeded" || !offer || !state.signed) {
    return (
      <>
        <FlowBand current={4} title="E-ticket" />
        <EmptyState title="No ticket yet" body="Your ticket and its proofs show up here after the gate check." href={state.signed ? "/search" : "/"} cta={state.signed ? "Back to search" : "Set up a trip"} />
      </>
    );
  }

  const m = state.draft;
  const price = booking.quotedPriceUsd ?? booking.priceUsd;
  const stepHash = (k: string) => booking.steps.find((s) => s.key === k)?.hash ?? "";

  const proofs = [
    { label: "Mandate hash", note: "SHA-256 of your rules", value: state.signed.hash, real: true },
    { label: "Your signature", note: `ML-DSA-87 · ${state.signed.sigBytes.toLocaleString()} bytes`, value: state.signed.sigPreview, real: true },
    { label: "Quote signature", note: "ML-DSA-87, checked by pqcVerify", value: booking.quoteSigPreview ?? "", real: true },
    { label: "Escrow payment", note: "FlightEscrow.book()", value: stepHash("lock"), real: false },
    { label: "Ticket proof", note: "ML-DSA-87, checked before payout", value: booking.proofSigPreview ?? "", real: true },
        { label: "Payout", note: "Released · FlightEscrow.confirmTicket()", value: stepHash("release"), real: false },
    { label: "Passport ciphertext", note: `ML-KEM-1024 · ${state.passenger?.kemCiphertextBytes.toLocaleString()} bytes`, value: `0x${state.passenger?.preview ?? ""}`, real: true },
  ];

  return (
    <>
      <FlowBand current={4} title="You're ticketed" subtitle="Escrow paid the merchant only after the ticket proof checked out." />

      <div className="mx-auto -mt-14 grid max-w-[1440px] gap-6 px-4 pb-24 lg:grid-cols-[1fr_380px] lg:px-8">
        <div className="min-w-0 space-y-6">
          {/* E-ticket */}
          <div className="grid overflow-hidden rounded-2xl border border-line bg-white shadow-card md:grid-cols-[1fr_240px]">
            <div className="space-y-6 p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <AirlineBadge offer={offer} size="lg" />
                  <div>
                    <p className="text-lg font-bold text-ink">{offer.carrier}</p>
                    <p className="font-mono text-sm text-muted">{offer.flightNo}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-pass-50 px-3 py-1 text-sm font-bold text-pass">
                  <CheckCircle2 className="size-4" /> Ticketed
                </span>
              </div>
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4">
                <div>
                  <p className="font-mono text-5xl font-semibold text-ink">{offer.from}</p>
                  <p className="tabular text-lg font-bold text-ink">{offer.depart}</p>
                  <p className="text-sm text-muted">Terminal {offer.fromTerminal}</p>
                </div>
                <div className="text-center text-sm text-muted">
                  <p>{formatDuration(offer.durationMin)}</p>
                  <div className="my-2 border-t-2 border-dashed border-line" />
                  <p>{offer.stops === 0 ? "Nonstop" : `via ${offer.via}`}</p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-5xl font-semibold text-ink">{offer.to}</p>
                  <p className="tabular text-lg font-bold text-ink">{offer.arrive}</p>
                  <p className="text-sm text-muted">Terminal {offer.toTerminal}</p>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Field k="Passenger" v={state.passenger?.displayName ?? "—"} />
                <Field k="Date" v={formatDateLong(offer.date)} />
                <Field k="Cabin" v={CABIN_LABEL[offer.cabin]} />
                <Field k="Baggage" v={offer.baggage} />
              </dl>
              <p className="text-xs text-muted">Duffel test-mode order. Same flow as a live booking.</p>
            </div>
            <div className="pass-notch flex flex-col items-center justify-center gap-3 border-t-2 border-dashed border-line bg-brand-50/60 p-6 md:border-t-0 md:border-l-2">
              <p className="text-xs font-bold tracking-[0.14em] text-muted uppercase">Booking ref</p>
              <p className="font-mono text-4xl font-semibold tracking-widest text-brand">{booking.pnr}</p>
              <Barcode seed={booking.pnr ?? "FLYGATE"} />
            </div>
          </div>

          {/* Proofs */}
          <Card id="proofs" className="overflow-hidden">
            <div className="border-b border-line px-6 py-4">
              <h2 className="text-lg font-bold text-ink">Proofs</h2>
              <p className="text-sm text-muted">Signatures and encryption are computed for real. Chain transactions are simulated in this demo.</p>
            </div>
            <ul className="divide-y divide-line">
              {proofs.map((p) => (
                <li key={p.label} className="grid gap-2 px-6 py-3 sm:grid-cols-[180px_1fr_auto] sm:items-center">
                  <div>
                    <p className="font-bold text-ink">{p.label}</p>
                    <p className="text-xs text-muted">{p.note}</p>
                  </div>
                  <HashText value={p.value} head={18} tail={6} className="justify-self-start" />
                  <SourceTag real={p.real} />
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-32 lg:self-start">
          <Card className="p-5">
            <p className="mb-3 text-sm font-bold text-muted">Payment</p>
            <div className="space-y-2 text-sm">
              <Row k="Fare" v={usd(price)} strong />
              <Row k="Your cap" v={usd(m.maxFareUsd)} />
              <Row k="Under cap by" v={usd(m.maxFareUsd - price)} />
              <Row k="Paid via" v="fUSD escrow" />
            </div>
          </Card>
          <Card className="p-5">
            <p className="mb-2 text-sm font-bold text-muted">Mandate</p>
            <p className="font-bold text-ink">
              {m.maxTickets}/{m.maxTickets} ticket used
            </p>
            <p className="mt-1 text-sm text-ink-2">Used up. The agent can&apos;t buy another one.</p>
          </Card>
          <div className={cx("rounded-2xl bg-night p-5 text-white shadow-card")}>
            <p className="inline-flex items-center gap-2 text-sm font-bold text-[#ff8a7a]">
              <Siren className="size-4" /> Next
            </p>
            <p className="mt-2 text-lg font-bold">What if the agent&apos;s key gets stolen?</p>
            <p className="mt-1 text-sm text-white/70">Attack with the leaked key, and a quantum computer.</p>
            <Link href="/drill" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-night hover:bg-white/90">
              Start breach drill <ArrowRight className="size-4" />
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold tracking-[0.12em] text-muted uppercase">{k}</dt>
      <dd className="font-bold text-ink">{v}</dd>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-2">{k}</span>
      <span className={cx("tabular", strong ? "text-xl font-bold text-brand" : "text-ink")}>{v}</span>
    </div>
  );
}

function Barcode({ seed }: { seed: string }) {
  const bars = Array.from({ length: 42 }, (_, i) => ((seed.charCodeAt(i % seed.length) * (i + 7)) % 4) + 1);
  return (
    <div className="flex h-14 items-stretch gap-[2px]" aria-hidden>
      {bars.map((w, i) => (
        <span key={i} className={i % 2 === 0 ? "bg-ink" : "bg-transparent"} style={{ width: `${w}px` }} />
      ))}
    </div>
  );
}
