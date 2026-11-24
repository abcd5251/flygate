import { usd } from "./mandate";
import { DEMO_OFFERS, PRICE_CHANGE_USD } from "./offers";
import { pqcVerifyMerchant, preview, signAsMerchant } from "./pq";
import type { ChainTx, DemoMode, LiveAddresses, Mandate, Scenario, TxKind, TxSource } from "./types";

/**
 * Browser-safe QoreChain (diana testnet) layer: constants, `shortAddr`, the simulation helpers
 * and the `ChainPort` interface the pages use for every on-chain step. Nothing here may touch
 * keys or `@qorechain/sdk`; live signing happens on the server (ADR-0001).
 */

export const CHAIN = {
  name: "QoreChain diana",
  chainId: "qorechain-diana",
  evmChainId: 9800,
  explorer: "https://explore.qore.network",
};

export const ADDRESSES = {
  owner: "qor1u7x3k9p2m4d8f6h5j0l2n4q6s8t0v2w4y6z8k2f",
  agent: "qor1agt9w2e4r6t8y0u2i4o6p8a0s2d4f6g8h0j7k2",
  merchant: "qor1mrc5z7x9c1v3b5n7m9q1w3e5r7t9y1u3i5o3p8",
  escrow: "0x7a3fd91c02b5e64a18c9f0d27e3b5a6c4d8ec41e",
  attacker: "0xbad0c0ffee000000000000000000000000dead00",
  pqcVerify: "0x0000000000000000000000000000000000000a01",
};

export const ERROR_CODES = {
  spending: { code: "abstractaccount 5", name: "spending_limit_exceeded" },
  permission: { code: "abstractaccount 10", name: "permission_denied" },
  replay: { code: "abstractaccount 11", name: "authenticator_replay" },
  expired: { code: "abstractaccount 6", name: "session_key_expired" },
  hybrid: { code: "pqc 21", name: "hybrid_verify_failed" },
  notLinked: { code: "abstractaccount 10", name: "authenticator not linked" },
};

export function shortAddr(a: string, head = 8, tail = 4) {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

export function fakeHash() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fakePnr() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

let seq = 0;
/** A simulated transaction with a random hash. Simulated mode only; live txs come from the API. */
export function makeTx(label: string, msg: string, kind: TxKind, ok = true, code?: string): ChainTx {
  seq += 1;
  return { id: `tx_${Date.now()}_${seq}`, label, msg, hash: fakeHash(), kind, ok, code, at: Date.now(), source: "simulated" };
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const STARTING_BALANCE_USD = 1000;

/**
 * The owner transactions the wallet sends after the mandate is signed, in order. Simulated keeps
 * its original three; Live sends link (key + spending rule in one tx), the Scoped window, then
 * setMandate (D-12).
 */
export type MandateTxStep = "link" | "spending" | "window" | "mandate";
export const MANDATE_TX_STEPS: Record<DemoMode, MandateTxStep[]> = {
  simulated: ["link", "spending", "window"],
  live: ["link", "window", "mandate"],
};

export type MandateChainInput = { step: MandateTxStep; mandate: Mandate; mandateHash?: string };
/** `bookingId` is the on-chain id fixed by the Live quote (absent in Simulated mode). */
export type BookingChainInput = { offerId: string; amountUsd: number; bookingId?: string };
export type QuoteInput = { offerId: string; scenario: Scenario; mandate: Mandate; mandateHash?: string };
/** `pnr` is hashed into the TicketProof the merchant signs. */
export type TicketInput = BookingChainInput & { pnr: string };

/**
 * The merchant's signed quote. Live: signed on the server with the merchant's registered
 * ML-DSA-87 key over the on-chain Quote; `bookingId` = keccak256(abi.encode(quote)) and
 * `priceQor` is the price at LIVE_QOR_PER_USD (D-14). `quoteId` names it for `verifyQuote`.
 */
export type CheckoutQuote =
  | { ok: true; quoteId: string; bookingId?: string; priceUsd: number; priceQor?: string; sigBytes: number; sigPreview: string; source: TxSource }
  | { ok: false; code: string; reason: string };

/** The quote signature check: in the browser (Simulated) or pqcVerify via eth_call (Live read). */
export type QuoteCheck = { ok: boolean; detail: string; source: TxSource; readResult?: string; code?: string };

/**
 * The ticket proof step. `release` is the payout the `Released` event of the same confirmTicket()
 * reports (same hash in Live). `sigBytes` / `sigPreview` are the merchant's TicketProof signature;
 * `verified` whether it checked out (Live: confirmTicket() succeeded).
 */
export type TicketProofResult = { proof: ChainTx; release: ChainTx; sigBytes?: number; sigPreview?: string; verified: boolean };
/** A tx found on-chain by its event log (0x hash) and its explorer link. */
export type OnchainTxRef = { hash: string; explorerUrl: string };

/** FlightEscrow's Status of one booking, as its events tell it. */
export type OnchainBookingState = "None" | "Locked" | "Released" | "Refunded";

/**
 * The booking-state query (Live read, no broadcast): what diana says happened to `bookingId`,
 * from its `Booked`, `Released` and `Refunded` events. After a reload the page asks this instead
 * of sending the step again (D-28). `deadline` (unix s) is when `refund()` opens for a Locked one.
 */
export type BookingStateResult =
  | {
      ok: true;
      source: "live";
      bookingId: string;
      state: OnchainBookingState;
      booked?: OnchainTxRef;
      released?: OnchainTxRef;
      refunded?: OnchainTxRef;
      deadline?: number;
    }
  | { ok: false; source: TxSource; code: string; reason: string };

/**
 * The Booking fails refund. Live: `tx` is the merchant-signed cancel() the agent EOA submitted;
 * after it succeeds the server reads the refund address (the owner's EVM signer, ADR-0002) once:
 * `readResult` / `balanceQor` ("Live read"), or `readError` when that read failed.
 */
export type CancelResult = { tx: ChainTx; refundTo?: string; balanceQor?: string; readResult?: string; readError?: string };
/** `bookingId` is the Live quote whose book() is simulated (absent in Simulated mode). */
export type FareCapInput = { offerId: string; priceUsd: number; maxFareUsd: number; bookingId?: string };

/** Result of the backup on-chain fare-cap check, run after the off-chain gate rejected a quote. */
export type FareCapCheck = {
  source: TxSource;
  /** A rejected tx (simulated). Live mode reads with eth_call instead and sends nothing. */
  tx?: ChainTx;
  /** Live: the decoded `FareOverCap(maxFareWei, priceWei)` and the owner's balance before/after. */
  readResult?: string;
  /** Live: whether the contract refused with FareOverCap and the balance did not move. */
  ok?: boolean;
  code?: string;
  detail?: string;
};

/**
 * Whether this chain can run the demo. Live: what /api/live/status reports (public data only);
 * `escrow` is the deployed FlightEscrow, never the placeholder `ADDRESSES.escrow`.
 */
export type ChainStatus = {
  available: boolean;
  reason?: string;
  escrow?: string;
  /** Explorer base URL; tx links are `${explorer}/tx/${hash}`. */
  explorer: string;
  addresses?: LiveAddresses;
};

/**
 * Every on-chain step of /mandate and /checkout goes through this port: `simulatedChain` (makeTx)
 * or `liveChain` (fetching /api/live/*), picked by `getChain(state.mode)`.
 */
export interface ChainPort {
  setupMandate(input: MandateChainInput): Promise<ChainTx>;
  /** The merchant signs the final quote. */
  signQuote(input: QuoteInput): Promise<CheckoutQuote>;
  /** pqcVerify on the signature of quote `quoteId` (Simulated re-signs from `input` after a reload). */
  verifyQuote(input: QuoteInput & { quoteId?: string }): Promise<QuoteCheck>;
  lockFunds(input: BookingChainInput): Promise<ChainTx>;
  /** The merchant signs the TicketProof and confirmTicket() pays out (`release`, same tx). */
  confirmTicket(input: TicketInput): Promise<TicketProofResult>;
  /** The merchant cancels a locked booking and the escrow refunds the owner (Booking fails). */
  cancelBooking(input: BookingChainInput): Promise<CancelResult>;
  checkFareCap(input: FareCapInput): Promise<FareCapCheck>;
  /** Where a booking stands on-chain (Live read); Simulated has no chain to ask. */
  bookingState(input: { bookingId: string }): Promise<BookingStateResult>;
  status(): Promise<ChainStatus>;
}

const SIMULATED_MANDATE_TXS: Record<MandateTxStep, readonly [label: string, msg: string]> = {
  link: ["Link agent key", "MsgRegisterAuthenticator"],
  spending: ["Set spending rules", "MsgUpdateSpendingRules"],
  window: ["Open scoped window", "MsgOpenEVMWindow"],
  mandate: ["Write mandate on-chain", "FlightEscrow.setMandate()"],
};

/** Simulated quotes by id, so verify checks the payload that was signed. */
const simulatedQuotes = new Map<string, { payload: unknown; sig: Uint8Array }>();
let quoteSeq = 0;

async function simulatedQuote(input: QuoteInput) {
  const offer = DEMO_OFFERS.find((o) => o.id === input.offerId);
  if (!offer) throw new Error(`Unknown offer ${input.offerId}`);
  const price = input.scenario === "price_change" ? PRICE_CHANGE_USD : offer.priceUsd;
  const payload = {
    offerId: offer.id,
    flight: offer.flightNo,
    route: `${offer.from}-${offer.to}`,
    date: offer.date,
    priceUsd: price,
    escrow: ADDRESSES.escrow,
    mandateHash: input.mandateHash,
    validUntil: Date.now() + 20 * 60_000,
  };
  const r = await signAsMerchant(payload);
  quoteSeq += 1;
  const quoteId = `sim_quote_${Date.now()}_${quoteSeq}`;
  simulatedQuotes.set(quoteId, { payload, sig: r.sig });
  return { quoteId, price, r };
}

export const simulatedChain: ChainPort = {
  async setupMandate({ step }) {
    const [label, msg] = SIMULATED_MANDATE_TXS[step];
    return makeTx(label, msg, "owner");
  },
  async signQuote(input) {
    const { quoteId, price, r } = await simulatedQuote(input);
    return { ok: true, quoteId, priceUsd: price, sigBytes: r.sigBytes, sigPreview: preview(r.sig), source: "simulated" };
  },
  async verifyQuote({ quoteId, ...input }) {
    // After a reload the in-memory quote is gone: sign a fresh one, as before.
    const { payload, sig } = (quoteId && simulatedQuotes.get(quoteId)) || simulatedQuotes.get((await simulatedQuote(input)).quoteId)!;
    const ok = await pqcVerifyMerchant(payload, sig);
    return { ok, detail: `pqcVerify(merchant key, quote, signature) → ${ok}`, source: "simulated" };
  },
  async lockFunds({ amountUsd }) {
    return makeTx(`Escrow ${usd(amountUsd)}`, "MsgExecuteEVM", "agent");
  },
  async confirmTicket({ offerId, pnr }) {
    const payload = { pnr, offerId, escrow: ADDRESSES.escrow, issuedAt: Date.now() };
    const r = await signAsMerchant(payload);
    const verified = await pqcVerifyMerchant(payload, r.sig);
    return {
      proof: makeTx("Ticket proof on-chain", "FlightEscrow.confirmTicket()", "merchant"),
      release: makeTx("Payout to merchant", "Released event · confirmTicket()", "contract"),
      sigBytes: r.sigBytes,
      sigPreview: preview(r.sig),
      verified,
    };
  },
  async cancelBooking({ amountUsd }) {
    return { tx: makeTx(`Refund ${usd(amountUsd)}`, "FlightEscrow.cancel()", "contract") };
  },
  async checkFareCap() {
    return { source: "simulated", tx: makeTx("Backup on-chain check: overspend rejected", "perTxLimit", "agent", false, "abstractaccount 5") };
  },
  async bookingState() {
    return { ok: false, source: "simulated", code: "simulated", reason: "Simulated bookings are not on-chain" };
  },
  async status() {
    return { available: true, escrow: ADDRESSES.escrow, explorer: CHAIN.explorer };
  },
};

/** A live step that failed before the server could answer: no hash, no "Live tx" label. */
function liveFailure(reason: string, code: string): ChainTx {
  return { id: `live_${Date.now()}`, label: "Live request failed", msg: "", hash: "", kind: "owner", ok: false, code, reason, at: Date.now(), source: "live" };
}

/** What the browser shows when /api/live/status cannot be reached or answers 404. */
function unavailable(reason: string): ChainStatus {
  return { available: false, reason, explorer: CHAIN.explorer };
}

/**
 * POST one structured request to a Live route. When the server cannot answer (unreachable, 404
 * because LIVE_MODE is off, 400), `failed(reason, code)` builds the step's failure instead.
 */
async function postLive<T>(path: string, body: unknown, failed: (reason: string, code: string) => T): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return failed("Live server unreachable", "rpc error");
  }
  if (res.status === 404) return failed("LIVE_MODE is not on", "live unavailable");
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    return failed(err.error ?? `HTTP ${res.status}`, `http ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Live mode: every on-chain step is a fetch to /api/live/*, where the server signs and sends to
 * diana (ADR-0001). The browser never sees keys or the SDK, only public results. /checkout
 * steps send only ids (offerId, scenario, bookingId, pnr) and the mandate (D-08).
 */
export const liveChain: ChainPort = {
  async setupMandate({ step, mandate, mandateHash }) {
    return postLive("/api/live/mandate", { step, mandate, mandateHash }, liveFailure);
  },
  async signQuote({ offerId, scenario, mandate }) {
    return postLive<CheckoutQuote>("/api/live/checkout", { step: "quote", offerId, scenario, mandate }, (reason, code) => ({ ok: false, code, reason }));
  },
  async verifyQuote({ quoteId }) {
    return postLive<QuoteCheck>("/api/live/checkout", { step: "verify", bookingId: quoteId }, (reason, code) => ({ ok: false, detail: reason, code, source: "live" }));
  },
  async lockFunds({ bookingId }) {
    return postLive("/api/live/checkout", { step: "lock", bookingId }, liveFailure);
  },
  async confirmTicket({ bookingId, pnr }) {
    return postLive<TicketProofResult>("/api/live/checkout", { step: "proof", bookingId, pnr }, (reason, code) => ({
      proof: liveFailure(reason, code),
      release: liveFailure(reason, code),
      verified: false,
    }));
  },
  async bookingState({ bookingId }) {
    return postLive<BookingStateResult>("/api/live/checkout", { step: "state", bookingId }, (reason, code) => ({ ok: false, source: "live", code, reason }));
  },
  async cancelBooking({ bookingId }) {
    return postLive<CancelResult>("/api/live/checkout", { step: "cancel", bookingId }, (reason, code) => ({ tx: liveFailure(reason, code) }));
  },
  async checkFareCap({ bookingId }) {
    return postLive<FareCapCheck>("/api/live/checkout", { step: "farecap", bookingId }, (reason, code) => ({ source: "live", ok: false, code, detail: reason }));
  },
  async status() {
    let res: Response;
    try {
      res = await fetch("/api/live/status", { cache: "no-store" });
    } catch {
      return unavailable("Live server unreachable");
    }
    if (res.status === 404) return unavailable("LIVE_MODE is not on");
    if (!res.ok) return unavailable(`Live status failed (HTTP ${res.status})`);
    return (await res.json()) as ChainStatus;
  },
};

/** The chain the pages use for the current demo mode. */
export function getChain(mode: DemoMode): ChainPort {
  return mode === "live" ? liveChain : simulatedChain;
}
