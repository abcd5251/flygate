import "server-only";
import { decodeFunctionResult, keccak256, stringToBytes } from "viem";
import type { BookingStateResult, CancelResult, CheckoutQuote, FareCapCheck, QuoteCheck, TicketProofResult } from "@/lib/chain";
import {
  bookingId as bookingIdOf,
  Cabin as EscrowCabin,
  DIANA_CHAIN_ID,
  encodeBook,
  encodeConfirmTicket,
  encodePqcVerify,
  FLIGHT_ESCROW_ABI,
  PQC_VERIFY_ABI,
  PQC_VERIFY_ADDRESS,
  quoteMessage,
  signMessage,
  signTicketProof,
  unixDay,
  type Domain,
  type Quote,
  type TicketProof,
} from "@/lib/escrow";
import { usd } from "@/lib/mandate";
import { DEMO_OFFERS, PRICE_CHANGE_USD } from "@/lib/offers";
import type { Cabin, ChainTx, Mandate, Offer, Scenario } from "@/lib/types";
import type { Hex, ServerChain } from "./chain";
import { createCancelStep } from "./cancel";
import type { LiveConfig } from "./config";
import { fareCapCheck } from "./farecap";
import type { LiveKeys } from "./keys";
import {
  BadRequest,
  controlHashOf,
  mandateHashOf,
  parseMandate,
  parseOwner,
  parseSessionKey,
  readMandate,
  STEP_TIMEOUT_MS,
  type MandateState,
  type OwnerAccount,
} from "./mandate";
import { createBookingState } from "./recovery";
import { formatQor, usdToUqor, WEI_PER_UQOR } from "./money";
import { errorText, txFactory, type Clock, type StepResult, type TxText } from "./tx";

/**
 * Live /checkout (#21, Ticketed): one server operation per booking step. `quote` checks that the
 * caller set the owner's on-chain mandate (its session key), signs an on-chain Quote with the
 * merchant's registered ML-DSA-87 key and fixes the bookingId; `verify` asks the pqcVerify
 * precompile (eth_call, "Live read"); `lock` has FlyGate's agent send book(), which moves the
 * price out of the owner's deposited budget into escrow; `proof` sends confirmTicket(), whose
 * `Released` event is the payout, so `release` reuses its hash. Fare jumps' eth_call of book()
 * (#22), cancel() (#23) and the booking-state query (#24) are steps here too.
 *
 * Every broadcast is idempotent per (step, bookingId) (D-28) and never retried, and needs the
 * session key of the mandate the booking was quoted under.
 */
export const CHECKOUT_STEPS = ["quote", "verify", "lock", "proof", "farecap", "cancel", "state"] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

/** A quote is valid for 20 minutes, like the simulated one (D-15). */
export const QUOTE_TTL_SECONDS = 20 * 60;
/** Seconds the merchant has to confirm the ticket after book() (D-15). */
export const TICKET_WINDOW_SECONDS = 600;

const SCENARIOS: readonly Scenario[] = ["normal", "price_change", "order_fail"];
const CABINS: Record<Cabin, EscrowCabin> = { economy: EscrowCabin.Economy, premium: EscrowCabin.PremiumEconomy, business: EscrowCabin.Business };
const BOOKING_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const PNR_RE = /^[A-Z0-9]{5,8}$/;

/** POST /api/live/checkout body: structured fields only; the server builds every tx (D-08). */
export interface CheckoutInput {
  step: unknown;
  /** The owner's qor1 address (quote). */
  owner?: unknown;
  /** The session key the owner's browser set the mandate with (every step but verify and state). */
  sessionKey?: unknown;
  offerId?: unknown;
  scenario?: unknown;
  mandate?: unknown;
  bookingId?: unknown;
  pnr?: unknown;
}

export type CheckoutResponse = CheckoutQuote | QuoteCheck | ChainTx | TicketProofResult | FareCapCheck | CancelResult | BookingStateResult;

// ------------------------------------------------------------------ parsing

export function parseOffer(raw: unknown): Offer {
  const offer = typeof raw === "string" ? DEMO_OFFERS.find((o) => o.id === raw) : undefined;
  if (!offer) throw new BadRequest("offerId is not a demo offer");
  return offer;
}

export function parseScenario(raw: unknown): Scenario {
  if (typeof raw !== "string" || !(SCENARIOS as readonly string[]).includes(raw)) throw new BadRequest(`scenario must be one of ${SCENARIOS.join(", ")}`);
  return raw as Scenario;
}

export function parseBookingId(raw: unknown): Hex {
  if (typeof raw !== "string" || !BOOKING_ID_RE.test(raw)) throw new BadRequest("bookingId must be a 32-byte 0x hash");
  return raw.toLowerCase() as Hex;
}

export function parsePnr(raw: unknown): string {
  if (typeof raw !== "string" || !PNR_RE.test(raw)) throw new BadRequest("pnr must be 5-8 uppercase letters or digits");
  return raw;
}

// ------------------------------------------------------------------ mapping (D-14, D-15)

/** The price the merchant quotes for a scenario: Fare jumps quotes US$428 (D-17). */
export function scenarioPriceUsd(offer: Offer, scenario: Scenario): number {
  return scenario === "price_change" ? PRICE_CHANGE_USD : offer.priceUsd;
}

/** A demo offer as FlightEscrow's Quote (D-15). Cities are the mandate's city codes. */
export function demoQuote(o: {
  offer: Offer;
  priceUsd: number;
  mandate: Mandate;
  merchant: Hex;
  /** FlyGate's agent: book()'s msg.sender. */
  agent: Hex;
  /** The owner whose mandate and budget the booking runs under; refunds go back to it. */
  owner: Hex;
  uqorPerUsd: bigint;
  nowMs: number;
}): Quote {
  return {
    merchant: o.merchant,
    agent: o.agent,
    owner: o.owner,
    offerId: keccak256(stringToBytes(o.offer.id)),
    priceWei: usdToUqor(o.priceUsd, o.uqorPerUsd) * WEI_PER_UQOR,
    origin: o.mandate.origin.code,
    destination: o.mandate.destination.code,
    departDay: unixDay(o.offer.date),
    cabin: CABINS[o.offer.cabin],
    refundable: o.offer.refundable,
    expiresAt: BigInt(Math.floor(o.nowMs / 1000) + QUOTE_TTL_SECONDS),
    ticketWindow: TICKET_WINDOW_SECONDS,
  };
}

/** "3.89" for 3.89 QOR (formatQor without the unit). */
const qorNumber = (uqor: bigint) => formatQor(uqor).replace(/ QOR$/, "");
const sigPreview = (sig: Hex) => `${sig.slice(0, 42)}…`;
const sigBytes = (sig: Hex) => (sig.length - 2) / 2;

// ------------------------------------------------------------------ the service part

export interface CheckoutDeps {
  chain: ServerChain;
  config: LiveConfig;
  clock: Clock;
  /** The deployed FlightEscrow when Live is available, else why not (cached status, D-27). */
  liveEscrow(): Promise<{ escrow: Hex } | { code: string; reason: string }>;
  keys(): Promise<LiveKeys>;
}

/** What the server keeps per quoted booking: everything later steps build their txs from. */
interface QuotedBooking {
  quote: Quote;
  signature: Hex;
  domain: Domain;
  owner: OwnerAccount;
  /** keccak256 of the session key the booking was quoted with; later steps must present that key. */
  controlHash: Hex;
  priceUsd: number;
  priceUqor: bigint;
}

/** Why a caller may not act under an owner's mandate, or undefined when it may. */
export function mandateRefusal(state: MandateState, expectedHash: Hex, nowMs: number): { code: string; reason: string } | undefined {
  if (!state.exists) return { code: "no mandate", reason: "This account has no mandate for FlyGate's agent; sign one on /mandate first" };
  if (state.revoked) return { code: "mandate revoked", reason: "The owner closed this mandate; sign a new one on /mandate" };
  if (state.mandateHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return { code: "not your session", reason: "The on-chain mandate was not set with this browser's session (or the rules changed); sign the mandate again here" };
  }
  if (Number(state.expiresAt) * 1000 < nowMs) return { code: "mandate expired", reason: "The mandate has expired; sign a new one on /mandate" };
  return undefined;
}

/** One cached step: whether it broadcast, and the response the client got. */
type Cached = { broadcast: boolean; response: CheckoutResponse; ok: boolean };

export function createCheckout({ chain, config, clock, liveEscrow, keys }: CheckoutDeps) {
  const tx = txFactory(clock, config.network.explorer);
  const quotes = new Map<Hex, QuotedBooking>();
  /** Idempotency table, keyed `${step}:${bookingId}` (D-28). */
  const done = new Map<string, Promise<Cached>>();

  /**
   * Runs a broadcasting step once per (step, bookingId). A repeat (StrictMode, double click,
   * second tab) gets the first call's response; only refusals before any broadcast are dropped,
   * so they may be tried again.
   */
  async function once(step: CheckoutStep, id: Hex, run: () => Promise<Cached>, onError: (err: unknown) => Cached): Promise<CheckoutResponse> {
    const key = `${step}:${id}`;
    const existing = done.get(key);
    if (existing) return (await existing).response;
    // Sends never throw (ServerChain contract): an exception is kept like a failed broadcast.
    const p = run().catch(onError);
    done.set(key, p);
    const r = await p;
    if (!r.broadcast && done.get(key) === p) done.delete(key);
    return r.response;
  }

  function refusedQuote(code: string, reason: string): CheckoutQuote {
    return { ok: false, code, reason };
  }

  async function quote(input: CheckoutInput): Promise<CheckoutQuote> {
    const offer = parseOffer(input.offerId);
    const scenario = parseScenario(input.scenario);
    const mandate = parseMandate(input.mandate);
    const owner = parseOwner(input.owner);
    const controlHash = controlHashOf(parseSessionKey(input.sessionKey));
    const live = await liveEscrow();
    if (!("escrow" in live)) return refusedQuote(live.code, live.reason);
    const k = await keys();
    const agent = k.roles.agent.signer.address;
    // Only the browser that set the owner's on-chain mandate may make the agent book under it.
    let state: MandateState;
    try {
      state = await readMandate(chain, live.escrow, owner.evm, agent);
    } catch (err) {
      return refusedQuote("rpc error", `Could not read the owner's mandate: ${errorText(err)}`);
    }
    const refusal = mandateRefusal(state, mandateHashOf({ mandate, owner: owner.evm, agent, controlHash }), clock.now());
    if (refusal) return refusedQuote(refusal.code, refusal.reason);

    const priceUsd = scenarioPriceUsd(offer, scenario);
    const q = demoQuote({
      offer,
      priceUsd,
      mandate,
      merchant: k.roles.merchant.account.evm,
      agent,
      owner: owner.evm,
      uqorPerUsd: config.uqorPerUsd,
      nowMs: clock.now(),
    });
    const domain: Domain = { chainId: DIANA_CHAIN_ID, escrow: live.escrow };
    // bookingId hashes the quote, which has no nonce: two quotes for the same offer in the same
    // second (e.g. Ticketed, then Booking fails) would share an id, and with it the first one's
    // idempotent lock/proof/cancel results. Move expiresAt on by a second until the id is new.
    while (quotes.has(bookingIdOf(q))) q.expiresAt += BigInt(1);
    // The merchant's bootstrap-registered key, the one pqcKeyStatus returns (D-32).
    const signature = signMessage(quoteMessage(q, domain), k.merchantPqc.secretKey);
    const id = bookingIdOf(q);
    const priceUqor = usdToUqor(priceUsd, config.uqorPerUsd);
    quotes.set(id, { quote: q, signature, domain, owner, controlHash, priceUsd, priceUqor });
    return { ok: true, quoteId: id, bookingId: id, priceUsd, priceQor: qorNumber(priceUqor), sigBytes: sigBytes(signature), sigPreview: sigPreview(signature), source: "live" };
  }

  /** The quoted booking, when the caller presents the session key it was quoted with. */
  function sessionBooking(input: CheckoutInput, id: Hex): { b?: QuotedBooking; refusal?: { code: string; reason: string } } {
    const b = quotes.get(id);
    if (!b) return { refusal: { code: "unknown booking", reason: "The server has no quote for this booking; nothing was sent" } };
    const key = parseSessionKey(input.sessionKey);
    if (controlHashOf(key) !== b.controlHash) return { b, refusal: { code: "not your session", reason: "This booking was quoted for another session; nothing was sent" } };
    return { b };
  }

  async function verify(input: CheckoutInput): Promise<QuoteCheck> {
    const id = parseBookingId(input.bookingId);
    const b = quotes.get(id);
    if (!b) return { ok: false, source: "live", code: "unknown booking", detail: "The server has no quote for this booking; sign the quote again" };
    const k = await keys();
    const data = encodePqcVerify(k.merchantPqc.publicKey, b.signature, quoteMessage(b.quote, b.domain));
    try {
      const r = await chain.ethCall({ to: PQC_VERIFY_ADDRESS, data });
      if (r.status !== "success") {
        return { ok: false, source: "live", code: "eth_call reverted", detail: `pqcVerify eth_call reverted: ${r.reason}` };
      }
      const valid = decodeFunctionResult({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", data: r.data });
      const readResult = `pqcVerify(merchant key, quote, signature) → ${valid}`;
      return { ok: valid, source: "live", readResult, detail: `${readResult} · eth_call on diana`, code: valid ? undefined : "invalid signature" };
    } catch (err) {
      return { ok: false, source: "live", code: "rpc error", detail: `pqcVerify eth_call failed: ${errorText(err)}` };
    }
  }

  function lockText(b: QuotedBooking): TxText {
    return { label: `Escrow ${usd(b.priceUsd)} (≈ ${formatQor(b.priceUqor)}) from your budget`, msg: "FlyGate agent → FlightEscrow.book()" };
  }

  async function lock(input: CheckoutInput): Promise<ChainTx> {
    const id = parseBookingId(input.bookingId);
    const unknown = { label: "Escrow payment", msg: "FlightEscrow.book()" };
    const { b, refusal } = sessionBooking(input, id);
    const asCached = (r: StepResult): Cached => ({ broadcast: r.broadcast, response: r.tx, ok: r.tx.ok });
    if (refusal) return tx.refused("agent", b ? lockText(b) : unknown, refusal.code, refusal.reason).tx;
    const run = async (): Promise<Cached> => {
      const text = lockText(b!);
      const live = await liveEscrow();
      if (!("escrow" in live)) return asCached(tx.refused("agent", text, live.code, live.reason));
      // FlyGate's agent sends book() and pays its gas; the price comes out of the owner's budget.
      const data = encodeBook(b!.quote, b!.signature);
      return asCached(tx.fromOutcome("agent", text, await chain.sendEvm("agent", { to: b!.domain.escrow, data, errorAbi: FLIGHT_ESCROW_ABI }, { timeoutMs: STEP_TIMEOUT_MS })));
    };
    return (await once("lock", id, run, (err) => ({ broadcast: true, ok: false, response: tx.refused("agent", lockText(b!), "internal error", errorText(err)).tx }))) as ChainTx;
  }

  const PROOF_TEXT: TxText = { label: "Ticket proof on-chain", msg: "FlightEscrow.confirmTicket() · submitted by agent" };
  const RELEASE_TEXT: TxText = { label: "Payout to merchant", msg: "Released · FlightEscrow.confirmTicket()" };

  /** The payout is the `Released` event of the confirmTicket() tx: same hash, same outcome (D-16). */
  function withRelease(proof: ChainTx, sig?: Hex): TicketProofResult {
    const release: ChainTx = { ...proof, ...RELEASE_TEXT, id: `${proof.id}_released`, kind: "contract" };
    return { proof, release, verified: proof.ok, ...(sig ? { sigBytes: sigBytes(sig), sigPreview: sigPreview(sig) } : {}) };
  }

  async function proof(input: CheckoutInput): Promise<TicketProofResult> {
    const id = parseBookingId(input.bookingId);
    const pnr = parsePnr(input.pnr);
    const refused = (code: string, reason: string): Cached => {
      const t = tx.refused("merchant", PROOF_TEXT, code, reason).tx;
      return { broadcast: false, ok: false, response: withRelease(t) };
    };
    const { b, refusal } = sessionBooking(input, id);
    if (refusal) return refused(refusal.code, refusal.reason).response as TicketProofResult;
    const run = async (): Promise<Cached> => {
      if (!b) return refused("unknown booking", "The server has no quote for this booking; nothing was sent");
      const locked = done.get(`lock:${id}`);
      if (!locked || !(await locked).ok) return refused("out of order", "book() has not succeeded for this booking; nothing was sent");
      const k = await keys();
      const ticket: TicketProof = { bookingId: id, pnrHash: keccak256(stringToBytes(pnr)), issuedAt: BigInt(Math.floor(clock.now() / 1000)) };
      const signature = signTicketProof(ticket, b.domain, k.merchantPqc);
      // Anyone may submit the merchant-signed proof; the agent's EOA does (D-19).
      const o = await chain.sendEvm("agent", { to: b.domain.escrow, data: encodeConfirmTicket(ticket, signature), errorAbi: FLIGHT_ESCROW_ABI }, { timeoutMs: STEP_TIMEOUT_MS });
      const r = tx.fromOutcome("merchant", PROOF_TEXT, o);
      return { broadcast: r.broadcast, ok: r.tx.ok, response: withRelease(r.tx, signature) };
    };
    const onError = (err: unknown): Cached => ({ ...refused("internal error", errorText(err)), broadcast: true });
    return (await once("proof", id, run, onError)) as TicketProofResult;
  }

  // Booking fails: the merchant's cancel() refunds the owner (#23, src/server/live/cancel.ts).
  const cancelStep = createCancelStep({
    chain,
    tx,
    keys,
    booking: (id) => quotes.get(id),
    budget: async (b) => (await readMandate(chain, b.domain.escrow, b.owner.evm, (await keys()).roles.agent.signer.address)).budgetWei,
    locked: async (id) => {
      const l = done.get(`lock:${id}`);
      return !!l && (await l).ok;
    },
  });
  async function cancel(input: CheckoutInput): Promise<CancelResult> {
    const id = parseBookingId(input.bookingId);
    const { refusal } = sessionBooking(input, id);
    if (refusal) return cancelStep.refused(id, refusal.code, refusal.reason).response;
    return (await once("cancel", id, () => cancelStep.run(id), (err) => cancelStep.onError(id, err))) as CancelResult;
  }

  /** The booking-state query (#24): a read; waits for this booking's in-flight broadcasts first. */
  const stateOf = createBookingState({
    chain,
    explorer: config.network.explorer,
    deployBlock: config.deployBlock,
    liveEscrow,
    async settle(id) {
      const pending = [...done].filter(([key]) => key.endsWith(`:${id}`)).map(([, p]) => p);
      await Promise.all(pending);
    },
  });
  const state = (input: CheckoutInput) => stateOf(parseBookingId(input.bookingId));

  async function checkout(input: CheckoutInput): Promise<CheckoutResponse> {
    const step = input.step;
    if (typeof step !== "string" || !(CHECKOUT_STEPS as readonly string[]).includes(step)) {
      throw new BadRequest(`step must be one of ${CHECKOUT_STEPS.join(", ")}`);
    }
    switch (step as CheckoutStep) {
      case "quote":
        return quote(input);
      case "verify":
        return verify(input);
      case "lock":
        return lock(input);
      case "proof":
        return proof(input);
      case "farecap": {
        // Fare jumps (#22): eth_call of book() with the quoted booking; never broadcasts.
        const b = quotes.get(parseBookingId(input.bookingId));
        if (!b) return { source: "live", ok: false, code: "unknown booking", detail: "The server has no quote for this booking; nothing was checked" } satisfies FareCapCheck;
        return fareCapCheck({ chain, keys }, b);
      }
      case "cancel":
        return cancel(input);
      case "state":
        return state(input);
    }
  }

  return { checkout, quote, verify, lock, proof, cancel, state };
}

