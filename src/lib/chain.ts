import { usd } from "./mandate";
import type { ChainTx, DemoMode, LiveAddresses, Mandate, TxKind, TxSource } from "./types";

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

/** The three owner transactions the wallet sends after the mandate is signed, in order. */
export type MandateTxStep = "link" | "spending" | "window";
export const MANDATE_TX_STEPS: MandateTxStep[] = ["link", "spending", "window"];

export type MandateChainInput = { step: MandateTxStep; mandate: Mandate; mandateHash?: string };
export type BookingChainInput = { offerId: string; amountUsd: number };
export type FareCapInput = { offerId: string; priceUsd: number; maxFareUsd: number };

/** Result of the backup on-chain fare-cap check, run after the off-chain gate rejected a quote. */
export type FareCapCheck = {
  source: TxSource;
  /** A rejected tx (simulated). Live mode reads with eth_call instead and sends nothing. */
  tx?: ChainTx;
  readResult?: string;
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
  lockFunds(input: BookingChainInput): Promise<ChainTx>;
  /** `release` is the payout the `Released` event of the same confirmTicket() reports. */
  confirmTicket(input: BookingChainInput): Promise<{ proof: ChainTx; release: ChainTx }>;
  cancelBooking(input: BookingChainInput): Promise<ChainTx>;
  checkFareCap(input: FareCapInput): Promise<FareCapCheck>;
  status(): Promise<ChainStatus>;
}

const SIMULATED_MANDATE_TXS: Record<MandateTxStep, readonly [label: string, msg: string]> = {
  link: ["Link agent key", "MsgRegisterAuthenticator"],
  spending: ["Set spending rules", "MsgUpdateSpendingRules"],
  window: ["Open scoped window", "MsgOpenEVMWindow"],
};

export const simulatedChain: ChainPort = {
  async setupMandate({ step }) {
    const [label, msg] = SIMULATED_MANDATE_TXS[step];
    return makeTx(label, msg, "owner");
  },
  async lockFunds({ amountUsd }) {
    return makeTx(`Escrow ${usd(amountUsd)}`, "MsgExecuteEVM", "agent");
  },
  async confirmTicket() {
    return {
      proof: makeTx("Ticket proof on-chain", "FlightEscrow.confirmTicket()", "merchant"),
      release: makeTx("Payout to merchant", "Released event · confirmTicket()", "contract"),
    };
  },
  async cancelBooking({ amountUsd }) {
    return makeTx(`Refund ${usd(amountUsd)}`, "FlightEscrow.cancel()", "contract");
  },
  async checkFareCap() {
    return { source: "simulated", tx: makeTx("Backup on-chain check: overspend rejected", "perTxLimit", "agent", false, "abstractaccount 5") };
  },
  async status() {
    return { available: true, escrow: ADDRESSES.escrow, explorer: CHAIN.explorer };
  },
};

/** Live chain operations that later tickets fill in (#20 /mandate, #21-#23 /checkout). */
function notYetLive(op: string): never {
  throw new Error(`Live ${op} is not available yet`);
}

/** What the browser shows when /api/live/status cannot be reached or answers 404. */
function unavailable(reason: string): ChainStatus {
  return { available: false, reason, explorer: CHAIN.explorer };
}

/**
 * Live mode: every on-chain step is a fetch to /api/live/*, where the server signs and sends to
 * diana (ADR-0001). The browser never sees keys or the SDK, only public results.
 */
export const liveChain: ChainPort = {
  async setupMandate() {
    return notYetLive("setupMandate");
  },
  async lockFunds() {
    return notYetLive("lockFunds");
  },
  async confirmTicket() {
    return notYetLive("confirmTicket");
  },
  async cancelBooking() {
    return notYetLive("cancelBooking");
  },
  async checkFareCap() {
    return notYetLive("checkFareCap");
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
