"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, Pause, Play, ShieldCheck, Sparkles } from "lucide-react";
import { AgentFeed } from "@/components/AgentFeed";
import { FlightCard } from "@/components/FlightCard";
import { EmptyState, FlowBand } from "@/components/FlowBand";
import { Card, cx, PrimaryButton } from "@/components/ui";
import { rankOffers } from "@/lib/gate";
import { CABIN_LABEL, formatDateLong, formatRange, usd } from "@/lib/mandate";
import { DATE_STRIP, DEMO_OFFERS } from "@/lib/offers";
import { newBooking } from "@/lib/booking";
import { useDemo } from "@/lib/store";
import type { AgentRun, FeedItem, Offer } from "@/lib/types";

type Sort = "agent" | "price" | "fast";

let feedSeq = 0;
function feed(who: FeedItem["who"], text: string, tone?: FeedItem["tone"]): FeedItem {
  feedSeq += 1;
  return { id: `f${Date.now()}_${feedSeq}`, at: Date.now(), who, text, tone };
}

export default function SearchPage() {
  const router = useRouter();
  const { state, ready, update, wait, latest } = useDemo();
  const m = state.draft;
  const [sort, setSort] = useState<Sort>("agent");
  const [onlyPassed, setOnlyPassed] = useState(false);
  const ranking = useMemo(() => rankOffers(DEMO_OFFERS, m), [m]);
  const run: AgentRun = state.agent ?? { phase: "idle", feed: [], shownOffers: 0, checkedOffers: 0 };
  const startedRef = useRef(false);

  function setRun(fn: (r: AgentRun) => AgentRun) {
    update((s) => ({ ...s, agent: fn(s.agent ?? { phase: "idle", feed: [], shownOffers: 0, checkedOffers: 0 }) }));
  }
  function push(item: FeedItem) {
    setRun((r) => ({ ...r, feed: [...r.feed, item] }));
  }

  function book(offer: Offer) {
    update((s) => ({
      ...s,
      agent: s.agent ? { ...s.agent, phase: "handoff", countdown: undefined } : s.agent,
      booking: newBooking(offer, s.scenario),
    }));
    router.push("/checkout");
  }

  // Run the agent once per mandate. Each await is cancellable so StrictMode's double mount is safe.
  useEffect(() => {
    if (!ready || !state.signed || startedRef.current) return;
    // Keep a finished or paused run; restart one that was interrupted by navigating away.
    if (state.agent && (state.agent.phase === "handoff" || state.agent.phase === "paused")) return;
    startedRef.current = true;
    let cancelled = false;

    (async () => {
      await wait(300);
      if (cancelled) return;
      setRun(() => ({ phase: "parsing", feed: [], shownOffers: 0, checkedOffers: 0 }));
      push(feed("agent", `Read mandate: ${m.origin.city} → ${m.destination.city}, ${formatRange(m.departFrom, m.departTo)}, ${CABIN_LABEL[m.cabin]}, max ${usd(m.maxFareUsd)}`));
      await wait(900);
      if (cancelled) return;
      setRun((r) => ({ ...r, phase: "querying" }));
      push(feed("merchant", `Asking Duffel for ${m.origin.code} → ${m.destination.airports.join("/")} fares`));
      for (let i = 1; i <= DEMO_OFFERS.length; i++) {
        await wait(260);
        if (cancelled) return;
        setRun((r) => ({ ...r, shownOffers: i }));
      }
      push(feed("merchant", `Got ${DEMO_OFFERS.length} offers`));
      await wait(500);
      if (cancelled) return;
      setRun((r) => ({ ...r, phase: "checking" }));
      push(feed("gate", "Checking each offer: fare, refund, cabin, date, route"));
      for (let i = 1; i <= DEMO_OFFERS.length; i++) {
        await wait(380);
        if (cancelled) return;
        const o = DEMO_OFFERS[i - 1];
        const v = ranking.verdicts[o.id];
        setRun((r) => ({ ...r, checkedOffers: i }));
        if (!v.ok) push(feed("gate", `Blocked ${o.flightNo}: ${v.firstFail?.detail}`, "block"));
      }
      push(feed("gate", `${ranking.passed.length} passed, ${ranking.blocked.length} blocked`, "pass"));
      await wait(700);
      if (cancelled) return;
      setRun((r) => ({ ...r, phase: "ranking" }));
      push(feed("agent", "Ranking the ones that passed: price, flight time, stops"));
      await wait(900);
      if (cancelled) return;
      const pick = ranking.pick;
      if (!pick) {
        push(feed("agent", "No flight passed the gate. The agent won't book.", "block"));
        setRun((r) => ({ ...r, phase: "paused" }));
        return;
      }
      setRun((r) => ({ ...r, pickId: pick.id, pickReason: ranking.reason }));
      push(feed("agent", `Picked ${pick.flightNo} · ${usd(pick.priceUsd)}. ${ranking.reason ?? ""}`, "pick"));
      push(feed("agent", "Inside your mandate, so no need to ask you. Booking in 5s."));
      for (let c = 5; c >= 1; c--) {
        if (cancelled) return;
        if (latest().agent?.phase === "paused") return;
        setRun((r) => ({ ...r, phase: "countdown", countdown: c }));
        await wait(1000);
      }
      if (cancelled || latest().agent?.phase === "paused") return;
      book(pick);
    })();

    return () => {
      cancelled = true;
      startedRef.current = false;
    };
    // The run is keyed on readiness and the signed mandate only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state.signed]);

  if (!ready) return null;
  if (!state.signed) {
    return (
      <>
        <FlowBand current={2} title="Agent search" />
        <EmptyState title="No mandate yet" body="Sign a mandate first, then the agent can book." href="/" cta="Set up a trip" />
      </>
    );
  }

  const shown = DEMO_OFFERS.slice(0, run.shownOffers);
  const checkedIds = new Set(DEMO_OFFERS.slice(0, run.checkedOffers).map((o) => o.id));
  let list = [...shown];
  if (onlyPassed) list = list.filter((o) => !checkedIds.has(o.id) || ranking.verdicts[o.id].ok);
  if (sort === "price") list.sort((a, b) => a.priceUsd - b.priceUsd);
  if (sort === "fast") list.sort((a, b) => a.durationMin - b.durationMin);
  if (sort === "agent" && run.checkedOffers >= DEMO_OFFERS.length) {
    const order = new Map(ranking.passed.map((o, i) => [o.id, i]));
    list.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  }

  const busy = ["parsing", "querying", "checking", "ranking", "countdown"].includes(run.phase);
  const allChecked = run.checkedOffers >= DEMO_OFFERS.length;
  const pick = DEMO_OFFERS.find((o) => o.id === run.pickId);
  const ruleCounts = ["fare", "refund", "cabin", "date", "route", "direct"].map((k) => {
    const checked = DEMO_OFFERS.slice(0, run.checkedOffers);
    const pass = checked.filter((o) => ranking.verdicts[o.id].checks.find((c) => c.key === k)?.ok).length;
    return { key: k, pass, total: checked.length };
  });
  const RULE_LABEL: Record<string, string> = {
    fare: `Fare ≤ ${usd(m.maxFareUsd)}`,
    refund: m.refundableOnly ? "Refundable only" : "Any fare type",
    cabin: CABIN_LABEL[m.cabin],
    date: `Departs ${formatRange(m.departFrom, m.departTo)}`,
    route: `${m.origin.code} → ${m.destination.airports.join("/")}`,
    direct: m.directOnly ? "Nonstop only" : "Stops OK",
  };

  return (
    <>
      <FlowBand current={2} title={`${m.origin.city} → ${m.destination.city}`} subtitle={`One-way · 1 adult · ${CABIN_LABEL[m.cabin]} · max ${usd(m.maxFareUsd)}`}>
        {run.phase === "countdown" && pick && (
          <div className="flex items-center gap-3 rounded-2xl bg-white/15 px-4 py-3 backdrop-blur">
            <span className="tabular text-3xl font-black">{run.countdown}</span>
            <span className="text-sm">
              seconds to auto-book
              <br />
              {pick.flightNo} · {usd(pick.priceUsd)}
            </span>
            <button
              type="button"
              onClick={() => setRun((r) => ({ ...r, phase: "paused", countdown: undefined }))}
              className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-sm font-bold text-brand"
            >
              <Pause className="size-4" /> Pause
            </button>
          </div>
        )}
      </FlowBand>

      <div className="mx-auto -mt-14 max-w-[1440px] space-y-5 px-4 pb-24 lg:px-8">
        {/* Date strip */}
        <Card className="overflow-x-auto p-0">
          <div className="grid min-w-[720px] grid-cols-7">
            {DATE_STRIP.map((d) => {
              const inside = d.date >= m.departFrom && d.date <= m.departTo;
              const active = d.date === m.departFrom;
              return (
                <div
                  key={d.date}
                  className={cx(
                    "border-r border-line px-3 py-3 text-center last:border-0",
                    active && "border-b-2 border-b-ink",
                    !inside && "bg-canvas/70",
                  )}
                >
                  <p className={cx("text-sm", inside ? "font-bold text-ink" : "text-muted")}>
                    {formatDateLong(d.date)}
                  </p>
                  <p className={cx("tabular text-sm", inside ? "text-ink-2" : "text-muted")}>
                    {inside ? (
                      `from ${usd(d.lowestUsd)}`
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Lock className="size-3" /> Outside mandate
                      </span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-[260px_1fr] xl:grid-cols-[260px_1fr_320px]">
          {/* Gate conditions as filters */}
          <aside className="space-y-4">
            <Card className="p-5">
              <p className="mb-1 inline-flex items-center gap-2 text-lg font-bold text-ink">
                <ShieldCheck className="size-5 text-brand" /> Gate rules
              </p>
              <p className="mb-4 text-xs text-muted">
                {run.shownOffers} offers · {run.checkedOffers} checked
              </p>
              <ul className="space-y-3">
                {ruleCounts.map((r) => (
                  <li key={r.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-ink">{RULE_LABEL[r.key]}</span>
                    <span className={cx("tabular text-xs", r.total && r.pass < r.total ? "text-block" : "text-muted")}>
                      {r.total ? `${r.pass}/${r.total} pass` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
              <label className="mt-5 flex cursor-pointer items-center gap-2 border-t border-line pt-4 text-sm text-ink">
                <input type="checkbox" className="size-4 accent-brand" checked={onlyPassed} onChange={(e) => setOnlyPassed(e.target.checked)} />
                Only show flights that passed
              </label>
            </Card>
            <Card className="p-5 text-sm text-ink-2">
              <p className="mb-1 font-bold text-ink">AI ranks. The gate decides.</p>
              <p>The AI reads your request and ranks flights. Fixed code and on-chain rules decide what it may buy.</p>
            </Card>
          </aside>

          {/* Results */}
          <main className="min-w-0 space-y-4">
            <div className="hero-band relative overflow-hidden rounded-2xl px-6 py-5 text-white">
              <p className="text-lg font-bold">
                {run.phase === "querying" && "The agent is fetching fares…"}
                {run.phase === "checking" && "The gate is checking each offer…"}
                {run.phase === "ranking" && "The agent is ranking flights that passed…"}
                {run.phase === "countdown" && `The agent picked ${pick?.flightNo}. Booking now.`}
                {run.phase === "paused" && (pick ? "Auto-booking paused. Pick a flight yourself." : "No flight passed the gate")}
                {(run.phase === "handoff" || run.phase === "idle" || run.phase === "parsing") && "Agent search"}
              </p>
              <p className="text-sm text-white/85">
                {DEMO_OFFERS.length} offers → {allChecked ? `${ranking.passed.length} passed the gate` : "checking"}
              </p>
            </div>

            <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-line bg-white text-center">
              {(
                [
                  ["agent", "Agent pick", pick ? usd(pick.priceUsd) : "—"],
                  ["price", "Cheapest", usd(Math.min(...DEMO_OFFERS.map((o) => o.priceUsd)))],
                  ["fast", "Fastest", "3h 10m"],
                ] as const
              ).map(([key, label, sub]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSort(key)}
                  className={cx("border-b-2 px-3 py-3", sort === key ? "border-ink" : "border-transparent hover:bg-canvas")}
                >
                  <p className="font-bold text-ink">{label}</p>
                  <p className="tabular text-sm text-ink-2">{sub}</p>
                </button>
              ))}
            </div>

            {run.phase === "querying" && run.shownOffers === 0 && <SkeletonCards />}

            {list.map((o) => {
              const checked = checkedIds.has(o.id);
              const picked = allChecked && o.id === run.pickId;
              return (
                <FlightCard
                  key={o.id}
                  offer={o}
                  verdict={ranking.verdicts[o.id]}
                  checked={checked}
                  picked={picked}
                  pickReason={picked ? run.pickReason : undefined}
                  disabled={!allChecked}
                  selectLabel={picked ? "Book this" : "Choose instead"}
                  onSelect={() => book(o)}
                />
              );
            })}
          </main>

          {/* Agent feed */}
          <aside className="space-y-4 lg:col-span-2 xl:col-span-1">
            <div className="xl:sticky xl:top-32">
              <AgentFeed items={run.feed} busy={busy} />
              {run.phase === "paused" && pick && (
                <PrimaryButton className="mt-4 w-full" onClick={() => book(pick)}>
                  <Play className="size-4" /> Let the agent book {pick.flightNo}
                </PrimaryButton>
              )}
              {run.phase === "countdown" && pick && (
                <PrimaryButton className="mt-4 w-full" onClick={() => book(pick)}>
                  <Sparkles className="size-4" /> Book now
                </PrimaryButton>
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function SkeletonCards() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl border border-line bg-white" />
      ))}
    </div>
  );
}
