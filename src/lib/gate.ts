import { CABIN_LABEL, formatRange, formatShortDate, usd } from "./mandate";
import { formatDuration } from "./offers";
import type { GateVerdict, Mandate, Offer, RuleCheck } from "./types";

/**
 * The gate: deterministic checks an offer must pass before the agent may pay.
 * The LLM never decides this; it only ranks offers that already passed.
 * The same limits are enforced again on chain by spending rules and the escrow contract.
 */
export function checkOffer(offer: Offer, m: Mandate, priceUsd = offer.priceUsd): GateVerdict {
  const inWindow = offer.date >= m.departFrom && offer.date <= m.departTo;
  const checks: RuleCheck[] = [
    {
      key: "fare",
      label: "Fare",
      ok: priceUsd <= m.maxFareUsd,
      detail: priceUsd <= m.maxFareUsd ? `${usd(priceUsd)} ≤ ${usd(m.maxFareUsd)}` : `${usd(priceUsd)} is over the ${usd(m.maxFareUsd)} cap`,
    },
    {
      key: "refund",
      label: "Refund",
      ok: !m.refundableOnly || offer.refundable,
      detail: offer.refundable ? "Refundable" : "Non-refundable",
    },
    {
      key: "cabin",
      label: "Cabin",
      ok: offer.cabin === m.cabin,
      detail: offer.cabin === m.cabin ? CABIN_LABEL[offer.cabin] : `${CABIN_LABEL[offer.cabin]} cabin`,
    },
    {
      key: "date",
      label: "Date",
      ok: inWindow,
      detail: inWindow ? formatShortDate(offer.date) : `${formatShortDate(offer.date)} is outside ${formatRange(m.departFrom, m.departTo)}`,
    },
    {
      key: "route",
      label: "Route",
      ok: m.origin.airports.includes(offer.from) && m.destination.airports.includes(offer.to),
      detail: `${offer.from} → ${offer.to}`,
    },
    {
      key: "direct",
      label: "Stops",
      ok: !m.directOnly || offer.stops === 0,
      detail: offer.stops === 0 ? "Nonstop" : `${offer.stops} stop`,
    },
  ];
  const firstFail = checks.find((c) => !c.ok);
  return { offerId: offer.id, ok: !firstFail, checks, firstFail };
}

/** Score used by the agent to rank offers that passed the gate (lower is better). */
export function agentScore(o: Offer) {
  return o.priceUsd + (o.durationMin / 60) * 20 + o.stops * 60;
}

export type Ranking = {
  verdicts: Record<string, GateVerdict>;
  passed: Offer[];
  blocked: Offer[];
  pick?: Offer;
  reason?: string;
};

export function rankOffers(offers: Offer[], m: Mandate): Ranking {
  const verdicts: Record<string, GateVerdict> = {};
  for (const o of offers) verdicts[o.id] = checkOffer(o, m);
  const passed = offers.filter((o) => verdicts[o.id].ok).sort((a, b) => agentScore(a) - agentScore(b));
  const blocked = offers.filter((o) => !verdicts[o.id].ok);
  const pick = passed[0];
  let reason: string | undefined;
  if (pick) {
    const cheapest = [...passed].sort((a, b) => a.priceUsd - b.priceUsd)[0];
    if (cheapest && cheapest.id !== pick.id) {
      const saved = cheapest.durationMin - pick.durationMin;
      reason = `${usd(pick.priceUsd - cheapest.priceUsd)} more than ${cheapest.flightNo}, but ${pick.stops === 0 ? "nonstop and " : ""}${formatDuration(saved)} faster.`;
    } else {
      reason = "Cheapest flight that passed the gate.";
    }
  }
  return { verdicts, passed, blocked, pick, reason };
}
