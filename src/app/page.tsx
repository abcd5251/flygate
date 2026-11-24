"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeftRight, ArrowRight, CalendarDays, KeyRound, Plane, ShieldCheck, Siren, Sparkles, Ticket, User } from "lucide-react";
import { SideNav } from "@/components/SideNav";
import { Card, cx, GhostButton, Pill, PrimaryButton } from "@/components/ui";
import { CABIN_LABEL, EXAMPLE_INTENT, formatDateLong, formatExpiry, mandateRules, parseIntent, PLACES, usd } from "@/lib/mandate";
import { useDemo } from "@/lib/store";
import type { Cabin, Mandate } from "@/lib/types";

const TABS = [
  { href: "/", label: "Flights", icon: Plane },
  { href: "/mandate", label: "Mandate", icon: ShieldCheck },
  { href: "/ticket", label: "Ticket", icon: Ticket },
  { href: "/drill", label: "Breach drill", icon: Siren },
];

function dayBefore(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}T23:59:00+08:00`;
}

export default function HomePage() {
  const router = useRouter();
  const { state, update } = useDemo();
  const m = state.draft;
  const [chips, setChips] = useState<string[]>([]);
  const locked = Boolean(state.signed);
  const rules = mandateRules(m);

  function patch(p: Partial<Mandate>) {
    update((s) => ({ ...s, draft: { ...s.draft, ...p } }));
  }

  function runParse() {
    const text = state.intentText || EXAMPLE_INTENT;
    update((s) => ({ ...s, intentText: text }));
    const { patch: p, chips: c } = parseIntent(text);
    patch(p);
    setChips(c);
  }

  return (
    <div className="mx-auto flex max-w-[1440px] gap-8 px-4 py-6 lg:px-8">
      <aside className="hidden w-52 shrink-0 lg:block">
        <SideNav />
      </aside>

      <main className="min-w-0 flex-1 space-y-12 pb-24">
        <section className="hero-band relative overflow-hidden rounded-3xl px-6 pt-12 pb-44 text-center text-white">
          <HeroDecor />
          <h1 className="relative text-3xl font-black tracking-tight text-balance md:text-5xl">AI books your flight. It can&apos;t overspend.</h1>
          <ul className="relative mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-white/90 md:text-base">
            <li className="inline-flex items-center gap-2">
              <KeyRound className="size-4" /> Stolen key? Still capped
            </li>
            <li className="inline-flex items-center gap-2">
              <Ticket className="size-4" /> Pay only when ticketed
            </li>
            <li className="inline-flex items-center gap-2">
              <ShieldCheck className="size-4" /> Quantum-safe signatures
            </li>
          </ul>
        </section>

        <Card className="relative mx-auto -mt-48 max-w-5xl p-0">
          <div className="flex justify-center gap-2 border-b border-line px-4 pt-5 md:gap-10">
            {TABS.map((t, i) => {
              const Icon = t.icon;
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={cx(
                    "flex flex-col items-center gap-1.5 border-b-2 px-2 pb-3 text-xs font-medium whitespace-nowrap transition md:px-3 md:text-sm",
                    i === 0 ? "border-brand text-brand" : "border-transparent text-ink hover:text-brand",
                  )}
                >
                  <Icon className="size-7 md:size-8" strokeWidth={1.8} />
                  {t.label}
                </Link>
              );
            })}
          </div>

          <div className="space-y-5 p-5 md:p-7">
            <div>
              <label htmlFor="intent" className="mb-2 block text-sm font-bold text-ink">
                Tell FlyGate what you need
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-canvas px-3 focus-within:border-brand focus-within:bg-white">
                  <Sparkles className="size-5 shrink-0 text-brand" />
                  <input
                    id="intent"
                    value={state.intentText}
                    disabled={locked}
                    onChange={(e) => update((s) => ({ ...s, intentText: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && runParse()}
                    placeholder={EXAMPLE_INTENT}
                    className="w-full bg-transparent py-3 text-base text-ink outline-none placeholder:text-muted"
                  />
                </div>
                <GhostButton disabled={locked} onClick={runParse}>
                  <Sparkles className="size-4" /> Parse
                </GhostButton>
              </div>
              {chips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {chips.map((c) => (
                    <Pill key={c} tone="brand" className="animate-pop">
                      {c}
                    </Pill>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-5 text-sm">
              <span className="inline-flex items-center gap-2 font-medium text-ink">
                <span className="grid size-4 place-items-center rounded-full border-2 border-brand">
                  <span className="size-1.5 rounded-full bg-brand" />
                </span>
                One-way
              </span>
              <label className="inline-flex cursor-pointer items-center gap-2 text-ink">
                <input type="checkbox" className="size-4 accent-brand" checked={m.directOnly} disabled={locked} onChange={(e) => patch({ directOnly: e.target.checked })} />
                Nonstop only
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_auto_1fr_1.4fr_1fr]">
              <Field label="From">
                <select aria-label="From" disabled={locked} value={m.origin.code} onChange={(e) => patch({ origin: PLACES[e.target.value] })} className="w-full bg-transparent font-bold text-ink outline-none">
                  {Object.values(PLACES).map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.city} ({p.code})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted">{m.origin.airportName}</p>
              </Field>
              <button
                type="button"
                onClick={() => patch({ origin: m.destination, destination: m.origin })}
                disabled={locked}
                aria-label="Swap origin and destination"
                className="mx-auto hidden size-10 place-items-center self-center rounded-full border border-line bg-white text-brand hover:bg-brand-50 disabled:text-muted xl:grid"
              >
                <ArrowLeftRight className="size-4" />
              </button>
              <Field label="To">
                <select aria-label="To" disabled={locked} value={m.destination.code} onChange={(e) => patch({ destination: PLACES[e.target.value] })} className="w-full bg-transparent font-bold text-ink outline-none">
                  {Object.values(PLACES).map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.city} ({p.code})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted">
                  {m.destination.airportName} · {m.destination.airports.join("/")}
                </p>
              </Field>
              <Field label="Depart between" icon={<CalendarDays className="size-4" />}>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    aria-label="Earliest departure"
                    disabled={locked}
                    value={m.departFrom}
                    onChange={(e) => e.target.value && patch({ departFrom: e.target.value, expiresAt: dayBefore(e.target.value) })}
                    className="w-full min-w-0 bg-transparent text-sm font-bold text-ink outline-none"
                  />
                  <span className="text-muted">—</span>
                  <input
                    type="date"
                    aria-label="Latest departure"
                    disabled={locked}
                    min={m.departFrom}
                    value={m.departTo}
                    onChange={(e) => e.target.value && patch({ departTo: e.target.value })}
                    className="w-full min-w-0 bg-transparent text-sm font-bold text-ink outline-none"
                  />
                </div>
                <p className="text-xs text-muted">From {formatDateLong(m.departFrom)}</p>
              </Field>
              <Field label="Traveler · Cabin" icon={<User className="size-4" />}>
                <select aria-label="Cabin" disabled={locked} value={m.cabin} onChange={(e) => patch({ cabin: e.target.value as Cabin })} className="w-full bg-transparent font-bold text-ink outline-none">
                  {(Object.keys(CABIN_LABEL) as Cabin[]).map((c) => (
                    <option key={c} value={c}>
                      1 adult · {CABIN_LABEL[c]}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted">1 traveler in this demo</p>
              </Field>
            </div>

            <div className="grid gap-3 rounded-2xl border border-brand-100 bg-brand-50/60 p-4 sm:grid-cols-2 xl:grid-cols-[auto_1fr_1fr_1fr] xl:items-center">
              <p className="inline-flex items-center gap-2 text-sm font-bold whitespace-nowrap text-brand">
                <ShieldCheck className="size-5" /> Gate rules
              </p>
              <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2">
                <span className="text-sm whitespace-nowrap text-muted">Max fare</span>
                <span className="font-bold text-ink">US$</span>
                <input
                  type="number"
                  min={50}
                  step={10}
                  disabled={locked}
                  value={m.maxFareUsd}
                  onChange={(e) => patch({ maxFareUsd: Math.max(0, Number(e.target.value) || 0) })}
                  className="tabular w-full min-w-0 bg-transparent text-lg font-bold text-ink outline-none"
                  aria-label="Max fare in US dollars"
                />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-2 rounded-xl border border-line bg-white px-3 py-2.5">
                <span className="text-sm text-ink">Refundable only</span>
                <input type="checkbox" className="size-5 accent-brand" disabled={locked} checked={m.refundableOnly} onChange={(e) => patch({ refundableOnly: e.target.checked })} />
              </label>
              <div className="rounded-xl border border-line bg-white px-3 py-2">
                <p className="text-xs text-muted">Mandate expires</p>
                <p className="tabular font-bold text-ink">{formatExpiry(m.expiresAt)}</p>
              </div>
            </div>

            <div className="flex flex-col items-stretch justify-between gap-4 md:flex-row md:items-center">
              <p className="text-sm text-ink-2">
                {locked ? (
                  "Mandate signed. Reset the demo to change it."
                ) : (
                  <>
                    These become <b className="text-ink">{rules.length} on-chain rules</b> the AI can&apos;t change.
                  </>
                )}
              </p>
              <PrimaryButton onClick={() => router.push("/mandate")} className="px-10 py-4 text-lg">
                {locked ? "View mandate" : "Create mandate"} <ArrowRight className="size-5" />
              </PrimaryButton>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-b-2xl border-t border-line bg-canvas/60 px-5 py-3 text-xs text-ink-2 md:px-7">
            <span className="font-bold text-ink">On-chain rules:</span>
            {rules.map((r) => (
              <span key={r.key} className="rounded-full border border-line bg-white px-2.5 py-1">
                {r.says}
              </span>
            ))}
          </div>
        </Card>

        {state.signed && (
          <Card className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex items-center gap-4">
              <span className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand">
                <ShieldCheck className="size-6" />
              </span>
              <div>
                <p className="font-bold text-ink">
                  Active mandate: {m.origin.city} → {m.destination.city}
                </p>
                <p className="text-sm text-muted">
                  Cap {usd(m.maxFareUsd)} · expires {formatExpiry(m.expiresAt)}
                </p>
              </div>
            </div>
            <Link href={state.booking ? (state.booking.status === "succeeded" ? "/ticket" : "/checkout") : "/search"} className="font-bold text-brand hover:underline">
              Continue →
            </Link>
          </Card>
        )}

        <HowItWorks />
      </main>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line px-4 py-2.5 focus-within:border-brand">
      <p className="mb-0.5 inline-flex items-center gap-1 text-xs text-muted">
        {icon}
        {label}
      </p>
      {children}
    </div>
  );
}

function HeroDecor() {
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 360" preserveAspectRatio="none" aria-hidden>
      <path d="M-20 300 C 200 180, 420 330, 640 170 S 980 90, 1040 40" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeDasharray="6 10" />
      <circle cx="640" cy="170" r="4" fill="rgba(255,255,255,0.6)" />
      <circle cx="200" cy="215" r="3" fill="rgba(255,255,255,0.5)" />
    </svg>
  );
}

function HowItWorks() {
  const steps = [
    { title: "You sign once", body: "Set the trip and a price cap. The rules go on-chain.", icon: ShieldCheck },
    { title: "The agent books", body: "AI picks the best flight. The gate blocks anything outside your rules.", icon: Sparkles },
    { title: "Pay on ticket", body: "Money waits in escrow until the ticket is issued. No ticket, auto refund.", icon: Ticket },
  ];
  return (
    <section id="how" className="mx-auto max-w-5xl scroll-mt-28">
      <h2 className="mb-5 text-2xl font-black text-ink">How it works</h2>
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={s.title} className="rounded-2xl border border-line bg-white p-5">
              <div className="mb-3 flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-full bg-brand font-bold text-white">{i + 1}</span>
                <Icon className="size-5 text-brand" />
              </div>
              <p className="mb-1 font-bold text-ink">{s.title}</p>
              <p className="text-sm leading-relaxed text-ink-2">{s.body}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
