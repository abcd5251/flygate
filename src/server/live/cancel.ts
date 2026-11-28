import "server-only";
import type { CancelResult } from "@/lib/chain";
import { encodeCancel, FLIGHT_ESCROW_ABI, signCancelProof, type CancelProof, type Domain } from "@/lib/escrow";
import { usd } from "@/lib/mandate";
import type { Hex, ServerChain } from "./chain";
import type { LiveKeys } from "./keys";
import { STEP_TIMEOUT_MS } from "./mandate";
import { formatQor, WEI_PER_UQOR } from "./money";
import { errorText, type txFactory, type TxText } from "./tx";

/**
 * Live /checkout, Booking fails (#23, D-18): after the simulated Duffel order fails, the merchant
 * signs `CancelProof{bookingId, reasonCode: 1}` with its registered ML-DSA-87 key, the agent's
 * coin-60 EOA submits `cancel()` (anyone may; the merchant's signature is the authority, D-19)
 * and FlightEscrow emits `Refunded(Cancelled)`: the price goes back to the owner's budget in
 * FlightEscrow (or straight to the owner, once they closed the mandate). One read of that budget
 * then shows the money came back.
 * `refund()` is not used: it waits for the ticket window and is left to `pnpm live:sweep`.
 */

/** `reasonCode` 1 = offer_no_longer_available, what the simulated Duffel order reports. */
export const CANCEL_REASON_OFFER_UNAVAILABLE = 1;

/** The booking fields cancel() needs, as the quote step kept them. */
export interface CancellableBooking {
  domain: Domain;
  owner: { evm: Hex };
  priceUsd: number;
  priceUqor: bigint;
}

export interface CancelDeps {
  chain: ServerChain;
  tx: ReturnType<typeof txFactory>;
  keys(): Promise<LiveKeys>;
  booking(id: Hex): CancellableBooking | undefined;
  /** The owner's budget for FlyGate's agent, in wei, read from FlightEscrow. */
  budget(b: CancellableBooking): Promise<bigint>;
  /** Whether book() succeeded for this booking (its cached lock step). */
  locked(id: Hex): Promise<boolean>;
}

/** One cancel run: whether it broadcast (only those are kept for idempotency), and the answer. */
export type CancelRun = { broadcast: boolean; ok: boolean; response: CancelResult };

const cancelText = (b?: CancellableBooking): TxText => ({
  label: b ? `Refund ${usd(b.priceUsd)} (≈ ${formatQor(b.priceUqor)})` : "Refund",
  // The merchant signs; the agent's EOA only submits (D-19).
  msg: "FlightEscrow.cancel() · submitted by agent",
});

/** "budget(owner 0x…) → 1.23 QOR": what the "Live read" shows. */
export function refundBalanceText(address: Hex, wei: bigint): string {
  return `mandateOf(owner ${address}).budget → ${formatQor(wei / WEI_PER_UQOR)}`;
}

export function createCancelStep({ chain, tx, keys, booking, budget, locked }: CancelDeps) {
  function refused(b: CancellableBooking | undefined, code: string, reason: string): CancelRun {
    return { broadcast: false, ok: false, response: { tx: tx.refused("merchant", cancelText(b), code, reason).tx } };
  }

  async function run(id: Hex): Promise<CancelRun> {
    const b = booking(id);
    if (!b) return refused(b, "unknown booking", "The server has no quote for this booking; nothing was sent");
    if (!(await locked(id))) return refused(b, "out of order", "book() has not succeeded for this booking; nothing was sent");
    const k = await keys();
    const proof: CancelProof = { bookingId: id, reasonCode: CANCEL_REASON_OFFER_UNAVAILABLE };
    const signature = signCancelProof(proof, b.domain, k.merchantPqc);
    const o = await chain.sendEvm("agent", { to: b.domain.escrow, data: encodeCancel(proof, signature), errorAbi: FLIGHT_ESCROW_ABI }, { timeoutMs: STEP_TIMEOUT_MS });
    const r = tx.fromOutcome("merchant", cancelText(b), o);
    if (!r.tx.ok) return { broadcast: r.broadcast, ok: false, response: { tx: r.tx } };

    // The refund goes back to the owner's budget (ADR-0003).
    const refundTo = b.owner.evm;
    try {
      const wei = await budget(b);
      const balanceQor = formatQor(wei / WEI_PER_UQOR);
      return { broadcast: true, ok: true, response: { tx: r.tx, refundTo, balanceQor, readResult: refundBalanceText(refundTo, wei) } };
    } catch (err) {
      // The refund is on-chain either way; only the proof of it could not be read.
      return { broadcast: true, ok: true, response: { tx: r.tx, refundTo, readError: `Could not read the owner's budget (${errorText(err)})` } };
    }
  }

  /** A cancel that threw after it may have broadcast: kept, never resent. */
  function onError(id: Hex, err: unknown): CancelRun {
    return { ...refused(booking(id), "internal error", errorText(err)), broadcast: true };
  }

  /** A refusal before anything was sent, for a caller that may not cancel this booking. */
  const refusedFor = (id: Hex, code: string, reason: string) => refused(booking(id), code, reason);

  return { run, onError, refused: refusedFor };
}
