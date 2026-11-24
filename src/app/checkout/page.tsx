"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, Lock, RotateCcw, ShieldX, X } from "lucide-react";
import { AirlineBadge } from "@/components/FlightCard";
import { EmptyState, FlowBand } from "@/components/FlowBand";
import { Card, cx, GhostButton, HashText, Pill, PrimaryButton, SourceTag, Spinner } from "@/components/ui";
import { newBooking, STEP_META } from "@/lib/booking";
import { ADDRESSES, fakeHash, fakePnr, getChain, shortAddr } from "@/lib/chain";
import { checkOffer, rankOffers } from "@/lib/gate";
import { formatDateLong, usd } from "@/lib/mandate";
import { DEMO_OFFERS, formatDuration, PRICE_CHANGE_USD } from "@/lib/offers";
import { pqcVerifyMerchant, preview, signAsMerchant } from "@/lib/pq";
import { useDemo } from "@/lib/store";
import type { Booking, BookingStep, BookingStepKey, ChainTx } from "@/lib/types";

const ACTOR_LABEL = { merchant: "Merchant", chain: "Chain", agent: "Agent", gate: "Gate" } as const;
const ACTOR_TONE = { merchant: "muted", chain: "pq", agent: "brand", gate: "pass" } as const;
const REAL_CRYPTO: BookingStepKey[] = ["quote", "verify", "proof"];

/** The step fields that come from a chain tx: its hash, where it came from and its explorer link. */
function txStep(tx: ChainTx): Pick<BookingStep, "hash" | "source" | "explorerUrl"> {
  return { hash: tx.hash, source: tx.source, explorerUrl: tx.explorerUrl };
}

export default function CheckoutPage() {
  const router = useRouter();
  const { state, ready, update, wait, latest, addTx } = useDemo();
  const booking = state.booking;
  const offer = DEMO_OFFERS.find((o) => o.id === booking?.offerId);
  const quoteRef = useRef<{ payload: unknown; sig: Uint8Array } | null>(null);
  const releaseRef = useRef<ChainTx | null>(null);
  const [stay, setStay] = useState(false);

  function patchBooking(fn: (b: Booking) => Booking) {
    update((s) => (s.booking ? { ...s, booking: fn(s.booking) } : s));
  }
  function setStep(key: BookingStepKey, patch: Partial<BookingStep>) {
    patchBooking((b) => ({ ...b, steps: b.steps.map((st) => (st.key === key ? { ...st, ...patch } : st)) }));
  }

  useEffect(() => {
    if (!ready || !booking || booking.status !== "running" || !offer) return;
    let cancelled = false;
    const chain = getChain();

    async function quotePayload() {
      const s = latest();
      const b = s.booking!;
      const price = b.scenario === "price_change" ? PRICE_CHANGE_USD : offer!.priceUsd;
      const payload = {
        offerId: offer!.id,
        flight: offer!.flightNo,
        route: `${offer!.from}-${offer!.to}`,
        date: offer!.date,
        priceUsd: price,
        escrow: ADDRESSES.escrow,
        mandateHash: s.signed?.hash,
        validUntil: Date.now() + 20 * 60_000,
      };
      const r = await signAsMerchant(payload);
      quoteRef.current = { payload, sig: r.sig };
      return { price, r };
    }

    async function run(key: BookingStepKey): Promise<"next" | "stop"> {
      const s = latest();
      const b = s.booking!;
      const m = s.draft;
      setStep(key, { status: "running" });
      await wait(key === "order" ? 1500 : 1000);
      if (cancelled) return "stop";

      switch (key) {
        case "quote": {
          const { price, r } = await quotePayload();
          patchBooking((bk) => ({ ...bk, quotedPriceUsd: price, quoteSigPreview: preview(r.sig) }));
          setStep(key, { status: "done", detail: `Quote ${usd(price)} · signature ${r.sigBytes.toLocaleString()} bytes`, at: Date.now() });
          return "next";
        }
        case "verify": {
          if (!quoteRef.current) await quotePayload();
          const ok = await pqcVerifyMerchant(quoteRef.current!.payload, quoteRef.current!.sig);
          setStep(key, { status: ok ? "done" : "failed", detail: `pqcVerify(merchant key, quote, signature) → ${ok}`, at: Date.now() });
          return ok ? "next" : "stop";
        }
        case "rules": {
          const price = b.quotedPriceUsd ?? offer!.priceUsd;
          const v = checkOffer(offer!, m, price);
          if (!v.ok) {
            setStep(key, { status: "failed", detail: `${v.firstFail?.detail}. The agent stopped before paying.`, at: Date.now() });
            const cap = await chain.checkFareCap({ offerId: offer!.id, priceUsd: price, maxFareUsd: m.maxFareUsd });
            if (cap.tx) addTx(cap.tx);
            update((st) => ({ ...st, scenario: "normal", booking: st.booking ? { ...st.booking, status: "blocked" } : st.booking }));
            return "stop";
          }
          setStep(key, { status: "done", detail: v.checks.map((c) => c.detail).join(" · "), at: Date.now() });
          return "next";
        }
        case "lock": {
          const tx = await chain.lockFunds({ offerId: offer!.id, amountUsd: b.quotedPriceUsd ?? b.priceUsd });
          addTx(tx);
          update((st) => ({ ...st, spentUsd: st.spentUsd + (b.quotedPriceUsd ?? b.priceUsd) }));
          setStep(key, { status: "done", detail: `${b.quotedPriceUsd ?? b.priceUsd} fUSD → ${shortAddr(ADDRESSES.escrow, 8, 4)}`, ...txStep(tx), at: Date.now() });
          return "next";
        }
        case "order": {
          if (b.scenario === "order_fail") {
            setStep(key, { status: "failed", detail: "Duffel: offer_no_longer_available (sold out)", at: Date.now() });
            patchBooking((bk) => ({ ...bk, steps: [...bk.steps.filter((st) => st.status !== "pending"), { key: "refund", status: "running" }] }));
            await wait(1200);
            if (cancelled) return "stop";
            const amount = b.quotedPriceUsd ?? b.priceUsd;
            const tx = await chain.cancelBooking({ offerId: offer!.id, amountUsd: amount });
            addTx(tx);
            update((st) => ({
              ...st,
              scenario: "normal",
              spentUsd: Math.max(0, st.spentUsd - amount),
              refundedUsd: st.refundedUsd + amount,
              booking: st.booking
                ? {
                    ...st.booking,
                    status: "refunded",
                    steps: st.booking.steps.map((x) =>
                      x.key === "refund" ? { ...x, status: "done", detail: `${amount} fUSD back to ${shortAddr(ADDRESSES.owner, 8, 4)}`, ...txStep(tx), at: Date.now() } : x,
                    ),
                  }
                : st.booking,
            }));
            return "stop";
          }
          setStep(key, { status: "done", detail: `Duffel order ord_${fakeHash().slice(2, 14)} created (test mode)`, at: Date.now() });
          return "next";
        }
        case "ticket": {
          const pnr = fakePnr();
          patchBooking((bk) => ({ ...bk, pnr }));
          setStep(key, { status: "done", detail: `Booking ref ${pnr}`, at: Date.now() });
          return "next";
        }
        case "proof": {
          const pnr = latest().booking?.pnr ?? "";
          const payload = { pnr, offerId: offer!.id, escrow: ADDRESSES.escrow, issuedAt: Date.now() };
          const r = await signAsMerchant(payload);
          const ok = await pqcVerifyMerchant(payload, r.sig);
          const { proof: tx, release } = await chain.confirmTicket({ offerId: offer!.id, amountUsd: b.quotedPriceUsd ?? b.priceUsd });
          releaseRef.current = release;
          addTx(tx);
          patchBooking((bk) => ({ ...bk, proofSigPreview: preview(r.sig) }));
          setStep(key, { status: ok ? "done" : "failed", detail: `ML-DSA-87 signature ${r.sigBytes.toLocaleString()} bytes · pqcVerify → ${ok}`, ...txStep(tx), at: Date.now() });
          return ok ? "next" : "stop";
        }
        case "release": {
          // The payout is the `Released` event of the confirmTicket() tx sent in the proof step.
          const tx = releaseRef.current;
          releaseRef.current = null;
          const proofStep = latest().booking?.steps.find((x) => x.key === "proof");
          if (tx && tx.hash !== proofStep?.hash) addTx(tx);
          // After a reload the ref is gone; fall back to the proof tx, which carries the event.
          const shown = tx ?? proofStep;
          update((st) => ({
            ...st,
            booking: st.booking
              ? {
                  ...st.booking,
                  status: "succeeded",
                  steps: st.booking.steps.map((x) =>
                    x.key === "release" ? { ...x, status: "done", detail: `${b.quotedPriceUsd ?? b.priceUsd} fUSD → ${shortAddr(ADDRESSES.merchant, 8, 4)}`, hash: shown?.hash, source: shown?.source, explorerUrl: shown?.explorerUrl, at: Date.now() } : x,
                  ),
                }
              : st.booking,
          }));
          return "stop";
        }
        default:
          return "stop";
      }
    }

    (async () => {
      await wait(200);
      while (!cancelled) {
        const b = latest().booking;
        if (!b || b.status !== "running") return;
        const next = b.steps.find((st) => st.status === "pending" || st.status === "running");
        if (!next) return;
        const result = await run(next.key);
        if (result === "stop") return;
      }
    })();

    return () => {
      cancelled = true;
    };
    // Restart the runner only when a different booking starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, booking?.offerId, booking?.status === "running"]);

  useEffect(() => {
    if (booking?.status !== "succeeded" || stay) return;
    const t = setTimeout(() => router.push("/ticket"), 3500);
    return () => clearTimeout(t);
  }, [booking?.status, stay, router]);

  if (!ready) return null;
  if (!booking || !offer || !state.signed) {
    return (
      <>
        <FlowBand current={3} title="Gate check" />
        <EmptyState title="No booking yet" body="Let the agent pick a flight first." href={state.signed ? "/search" : "/"} cta={state.signed ? "Back to search" : "Set up a trip"} />
      </>
    );
  }

  const m = state.draft;
  const price = booking.quotedPriceUsd ?? booking.priceUsd;
  const alternative = rankOffers(DEMO_OFFERS, m).passed.find((o) => o.id !== offer.id);
  const locked = booking.steps.find((s) => s.key === "lock")?.status === "done";

  function retryWith(o: typeof offer) {
    if (!o) return;
    update((s) => ({ ...s, booking: newBooking(o, s.scenario) }));
  }

  function searchAgain() {
    update((s) => ({ ...s, booking: undefined, agent: undefined }));
    router.push("/search");
  }

  return (
    <>
      <FlowBand current={3} title="Gate check" subtitle="Money moves only when every step passes. If anything fails, it stays with you." />

      <div className="mx-auto -mt-14 grid max-w-[1440px] gap-6 px-4 pb-24 lg:grid-cols-[1fr_380px] lg:px-8">
        <div className="min-w-0 space-y-5">
          {booking.status === "blocked" && (
            <Callout tone="block" icon={<ShieldX className="size-6" />} title="Blocked by the gate">
              <p>
                The final quote jumped to <b>{usd(price)}</b>, over your {usd(m.maxFareUsd)} cap. The agent stopped before paying. Nothing left your wallet.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                {alternative && (
                  <PrimaryButton onClick={() => retryWith(alternative)}>
                    Book {alternative.flightNo} · {usd(alternative.priceUsd)} instead
                  </PrimaryButton>
                )}
                <GhostButton onClick={searchAgain}>Back to search</GhostButton>
              </div>
            </Callout>
          )}
          {booking.status === "refunded" && (
            <Callout tone="warn" icon={<RotateCcw className="size-6" />} title={`Booking failed. ${usd(price)} refunded.`}>
              <p>No ticket, no payout. The contract refunded you automatically.</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <PrimaryButton onClick={searchAgain}>Search again</PrimaryButton>
              </div>
            </Callout>
          )}
          {booking.status === "succeeded" && (
            <Callout tone="pass" icon={<CheckCircle2 className="size-6" />} title={`Ticketed · Booking ref ${booking.pnr}`}>
              <p>Escrow paid {usd(price)} only after verifying the signed ticket proof. {!stay && "Opening your ticket…"}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <PrimaryButton onClick={() => router.push("/ticket")}>
                  View ticket <ArrowRight className="size-5" />
                </PrimaryButton>
                {!stay && <GhostButton onClick={() => setStay(true)}>Stay here</GhostButton>}
              </div>
            </Callout>
          )}

          <Card className="p-6">
            <h2 className="mb-5 text-lg font-bold text-ink">Steps</h2>
            <ol className="relative space-y-0">
              {booking.steps.map((st, i) => {
                const meta = STEP_META[st.key];
                const last = i === booking.steps.length - 1;
                return (
                  <li key={st.key} className="relative flex gap-4 pb-6 last:pb-0">
                    {!last && <span className={cx("absolute top-9 left-[17px] h-[calc(100%-2rem)] w-0.5", st.status === "done" ? "bg-pass" : "bg-line")} aria-hidden />}
                    <StatusDot status={st.status} />
                    <div className="min-w-0 flex-1 pt-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={cx("font-bold", st.status === "pending" ? "text-muted" : st.status === "failed" ? "text-block" : "text-ink")}>{meta.title}</p>
                        <Pill tone={ACTOR_TONE[meta.actor]}>{ACTOR_LABEL[meta.actor]}</Pill>
                        {st.status === "done" && REAL_CRYPTO.includes(st.key) && <SourceTag kind="crypto" />}
                        {st.status === "done" && st.source === "live" && <SourceTag kind={st.hash ? "live-tx" : "live-read"} />}
                      </div>
                      {meta.msg && <p className="font-mono text-xs text-muted">{meta.msg}</p>}
                      {st.detail && <p className={cx("mt-1 text-sm", st.status === "failed" ? "text-block" : "text-ink-2")}>{st.detail}</p>}
                    </div>
                    <div className="hidden shrink-0 pt-1 text-right sm:block">
                      {st.hash && <HashText value={st.hash} head={8} tail={4} explorerUrl={st.explorerUrl} />}
                      {st.at && <p className="tabular text-[11px] text-muted">{new Date(st.at).toLocaleTimeString("zh-TW", { hour12: false })}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-32 lg:self-start">
          <Card className="p-5">
            <p className="mb-3 text-sm font-bold text-muted">Your flight</p>
            <div className="flex items-center gap-3">
              <AirlineBadge offer={offer} />
              <div>
                <p className="font-bold text-ink">
                  {offer.carrier} {offer.flightNo}
                </p>
                <p className="text-sm text-muted">{formatDateLong(offer.date)}</p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-3">
              <div>
                <p className="tabular text-xl font-bold text-ink">{offer.depart}</p>
                <p className="text-xs text-muted">{offer.from}</p>
              </div>
              <p className="text-center text-xs text-muted">{formatDuration(offer.durationMin)}</p>
              <div className="text-right">
                <p className="tabular text-xl font-bold text-ink">{offer.arrive}</p>
                <p className="text-xs text-muted">{offer.to}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
              <span className="text-sm text-ink-2">{state.passenger?.displayName ?? "Traveler"}</span>
              <span className={cx("tabular text-2xl font-bold", price > m.maxFareUsd ? "text-block" : "text-brand")}>{usd(price)}</span>
            </div>
          </Card>

          <Card className="p-5">
            <p className="mb-3 text-sm font-bold text-muted">Budget</p>
            <Budget max={m.maxFareUsd} used={booking.status === "refunded" ? 0 : locked ? price : 0} pending={!locked ? price : 0} />
            <p className="mt-3 text-xs text-ink-2">Only your ML-DSA-87 key can raise the cap.</p>
          </Card>

          <Card className="space-y-3 p-5 text-sm">
            <p className="inline-flex items-center gap-2 font-bold text-muted">
              <Lock className="size-4 text-pq" /> Security
            </p>
            <p className="text-ink">The merchant gets your passport as ML-KEM-1024 ciphertext. The agent never sees it.</p>
            <div className="flex items-center justify-between">
              <span className="text-ink-2">Escrow</span>
              <HashText value={ADDRESSES.escrow} head={8} tail={4} />
            </div>
            <p className="text-xs text-muted">
              Chain txs are simulated in this demo; signatures are real.{" "}
              <Link href="/ticket#proofs" className="text-brand hover:underline">
                All proofs
              </Link>
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}

function StatusDot({ status }: { status: BookingStep["status"] }) {
  return (
    <span
      className={cx(
        "relative z-10 grid size-9 shrink-0 place-items-center rounded-full border-2",
        status === "done" && "border-pass bg-pass text-white",
        status === "running" && "border-brand bg-white text-brand",
        status === "failed" && "border-block bg-block text-white",
        status === "pending" && "border-line bg-white text-muted",
        status === "skipped" && "border-line bg-canvas text-muted",
      )}
    >
      {status === "done" && <Check className="size-4" strokeWidth={3} />}
      {status === "running" && <Spinner />}
      {status === "failed" && <X className="size-4" strokeWidth={3} />}
    </span>
  );
}

function Budget({ max, used, pending }: { max: number; used: number; pending: number }) {
  const usedPct = Math.min(100, (used / max) * 100);
  const pendingPct = Math.min(100 - usedPct, (pending / max) * 100);
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-canvas">
        <span className="h-full bg-brand transition-all" style={{ width: `${usedPct}%` }} />
        <span className="h-full bg-brand-100 transition-all" style={{ width: `${pendingPct}%` }} />
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <span className="text-ink-2">
          Locked <b className="tabular text-ink">{usd(used)}</b>
        </span>
        <span className="text-muted">Cap {usd(max)}</span>
      </div>
    </div>
  );
}

function Callout({ tone, icon, title, children }: { tone: "pass" | "block" | "warn"; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const styles = {
    pass: "border-pass/30 bg-pass-50 text-pass",
    block: "border-block/30 bg-block-50 text-block",
    warn: "border-warn/30 bg-warn-50 text-warn",
  }[tone];
  return (
    <div className={cx("animate-fade-up rounded-2xl border p-5", styles)} role="status">
      <p className="mb-2 inline-flex items-center gap-2 text-lg font-bold">
        {tone === "block" ? icon : tone === "warn" ? <AlertTriangle className="size-6" /> : icon}
        {title}
      </p>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}
