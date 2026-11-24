import type { Booking, BookingStepKey, Offer, Scenario } from "./types";

export const STEP_META: Record<BookingStepKey, { title: string; actor: "merchant" | "chain" | "agent" | "gate"; msg?: string }> = {
  quote: { title: "Merchant signs the quote", actor: "merchant", msg: "ML-DSA-87" },
  verify: { title: "Contract verifies the signature", actor: "chain", msg: "pqcVerify 0x…0a01" },
  rules: { title: "Gate checks your mandate", actor: "gate" },
  lock: { title: "Agent pays into escrow", actor: "agent", msg: "MsgExecuteEVM → FlightEscrow.book()" },
  order: { title: "Merchant books with Duffel", actor: "merchant", msg: "POST /air/orders" },
  ticket: { title: "Airline issues the ticket", actor: "merchant" },
  proof: { title: "Contract verifies the ticket proof", actor: "chain", msg: "FlightEscrow.confirmTicket()" },
  release: { title: "Escrow pays the merchant", actor: "chain", msg: "Released event · inside confirmTicket()" },
  refund: { title: "Escrow refunds you", actor: "chain", msg: "FlightEscrow.cancel() → Refunded" },
};

const HAPPY_PATH: BookingStepKey[] = ["quote", "verify", "rules", "lock", "order", "ticket", "proof", "release"];

export function newBooking(offer: Offer, scenario: Scenario): Booking {
  return {
    offerId: offer.id,
    priceUsd: offer.priceUsd,
    scenario,
    status: "running",
    steps: HAPPY_PATH.map((key) => ({ key, status: "pending" })),
  };
}
