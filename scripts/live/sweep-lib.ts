// Pure parts of `pnpm live:sweep` (#25, D-26): settings, FlightEscrow event decoding, which
// bookings are stuck, and the sweep loop itself over a small chain interface. Nothing here
// touches the network; sweep.ts supplies the diana implementation, tests use FakeSweepChain.
import { decodeEventLog, parseAbi, type Log } from "viem";
import { assertNoSecrets, errorText, explorerTxUrl, parseEnvText, type Hex } from "./probe-lib";

// ------------------------------------------------------------------ settings (read-only)

export interface SweepEnv {
  escrow: Hex;
  deployBlock: bigint;
  evmRpc: string;
  rpc: string;
  rest: string;
  chainId: string;
  explorer: string;
  /** Secret: never print, log or write it. Sends the refund() txs (the owner's coin-60 signer). */
  ownerMnemonic: string;
}

const DEFAULTS = {
  QORE_CHAIN_ID: "qorechain-diana",
  QORE_RPC_URL: "https://rpc-testnet.qore.host",
  QORE_REST_URL: "https://api-testnet.qore.host",
  QORE_EVM_RPC_URL: "https://evm-testnet.qore.host",
  QORE_EXPLORER_URL: "https://explore.qore.network",
};

/**
 * The settings the sweep needs, from the process env first and then the env file's text.
 * Fails (naming the variable, never a value) when the escrow address or deploy block is
 * missing or malformed: without them there is nothing to scan.
 */
export function readSweepEnv(env: Record<string, string | undefined>, fileText = ""): SweepEnv {
  const file = parseEnvText(fileText);
  const get = (key: string): string | undefined => env[key]?.trim() || file[key]?.trim() || undefined;
  const escrow = get("FLIGHT_ESCROW_ADDRESS");
  const block = get("FLIGHT_ESCROW_DEPLOY_BLOCK");
  if (!escrow) throw new Error("FLIGHT_ESCROW_ADDRESS is not set: no FlightEscrow to sweep. Nothing sent.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrow)) throw new Error("FLIGHT_ESCROW_ADDRESS is not a valid 0x address. Nothing sent.");
  if (!block) throw new Error("FLIGHT_ESCROW_DEPLOY_BLOCK is not set: no block to start scanning from. Nothing sent.");
  if (!/^\d+$/.test(block)) throw new Error("FLIGHT_ESCROW_DEPLOY_BLOCK is not a block number. Nothing sent.");
  const ownerMnemonic = get("OWNER_MNEMONIC");
  if (!ownerMnemonic) throw new Error("OWNER_MNEMONIC is not set (it signs the refund() txs). Nothing sent.");
  return {
    escrow: escrow as Hex,
    deployBlock: BigInt(block),
    evmRpc: get("QORE_EVM_RPC_URL") ?? DEFAULTS.QORE_EVM_RPC_URL,
    rpc: get("QORE_RPC_URL") ?? DEFAULTS.QORE_RPC_URL,
    rest: get("QORE_REST_URL") ?? DEFAULTS.QORE_REST_URL,
    chainId: get("QORE_CHAIN_ID") ?? DEFAULTS.QORE_CHAIN_ID,
    explorer: (get("QORE_EXPLORER_URL") ?? DEFAULTS.QORE_EXPLORER_URL).replace(/\/+$/, ""),
    ownerMnemonic,
  };
}

// ------------------------------------------------------------------ FlightEscrow events

export const ESCROW_EVENTS_ABI = parseAbi([
  "event MandateSet(address indexed owner, address indexed agent, address indexed merchant, bytes32 mandateHash)",
  "event Booked(bytes32 indexed bookingId, address indexed agent, address indexed merchant, uint256 priceWei, uint64 deadline)",
  "event Released(bytes32 indexed bookingId, bytes32 pnrHash)",
  "event Refunded(bytes32 indexed bookingId, uint8 reason)",
]);
export const REFUND_ABI = parseAbi(["function refund(bytes32 bookingId)"]);

export type EscrowEvent =
  | { kind: "MandateSet"; owner: Hex; agent: Hex }
  | { kind: "Booked"; bookingId: Hex; agent: Hex; merchant: Hex; priceWei: bigint; deadline: bigint }
  | { kind: "Released"; bookingId: Hex }
  | { kind: "Refunded"; bookingId: Hex };

/** One raw log -> the event it is, or undefined for anything else the address emitted. */
export function decodeEscrowLog(log: Pick<Log, "topics" | "data">): EscrowEvent | undefined {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: ESCROW_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
  } catch {
    return undefined;
  }
  const a = decoded.args;
  switch (decoded.eventName) {
    case "MandateSet":
      return { kind: "MandateSet", owner: (a as { owner: Hex }).owner, agent: (a as { agent: Hex }).agent };
    case "Booked": {
      const b = a as { bookingId: Hex; agent: Hex; merchant: Hex; priceWei: bigint; deadline: bigint };
      return { kind: "Booked", bookingId: b.bookingId, agent: b.agent, merchant: b.merchant, priceWei: b.priceWei, deadline: b.deadline };
    }
    case "Released":
      return { kind: "Released", bookingId: (a as { bookingId: Hex }).bookingId };
    case "Refunded":
      return { kind: "Refunded", bookingId: (a as { bookingId: Hex }).bookingId };
  }
}

export interface LockedBooking {
  bookingId: Hex;
  agent: Hex;
  priceWei: bigint;
  deadline: bigint;
  /** The mandate owner the contract recorded for the agent (where refund() pays), when seen. */
  owner?: Hex;
}

export interface Classified {
  /** Locked and past the ticket deadline: refund() will pay the owner back. */
  expired: LockedBooking[];
  /** Locked, deadline not passed yet: left alone. */
  pending: LockedBooking[];
  /** Released or refunded already. */
  settled: number;
}

/**
 * Bookings from events in log order. Booking status is not readable on chain, so it is derived:
 * Booked -> Locked, then Released / Refunded settle it. `now` is the latest block's timestamp;
 * like the contract (`block.timestamp <= deadline` reverts), only `now > deadline` is expired.
 */
export function classifyBookings(events: readonly EscrowEvent[], now: bigint): Classified {
  const owners = new Map<string, Hex>();
  const locked = new Map<string, LockedBooking>();
  let settled = 0;
  for (const e of events) {
    if (e.kind === "MandateSet") {
      // The first setter stays the owner for good (setMandate reverts for anyone else).
      if (!owners.has(e.agent.toLowerCase())) owners.set(e.agent.toLowerCase(), e.owner);
    } else if (e.kind === "Booked") {
      locked.set(e.bookingId.toLowerCase(), {
        bookingId: e.bookingId,
        agent: e.agent,
        priceWei: e.priceWei,
        deadline: e.deadline,
        owner: owners.get(e.agent.toLowerCase()),
      });
    } else if (locked.delete(e.bookingId.toLowerCase())) {
      settled++;
    }
  }
  const all = [...locked.values()];
  return {
    expired: all.filter((b) => now > b.deadline),
    pending: all.filter((b) => now <= b.deadline),
    settled,
  };
}

/** "1h 02m 05s", "3m 10s", "42s". */
export function formatRemaining(seconds: bigint): string {
  const s = Number(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(r).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** 18-decimal wei as QOR, trailing zeros trimmed. */
export function formatQorWei(wei: bigint): string {
  const unit = BigInt(10) ** BigInt(18);
  const frac = (wei % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return `${wei / unit}${frac ? `.${frac}` : ""} QOR`;
}

// ------------------------------------------------------------------ the chain the sweep uses

/** Outcome of one refund() send. Every send is broadcast at most once and never resent. */
export type RefundOutcome =
  | { kind: "refunded"; hash: Hex }
  /** Mined, but the receipt says reverted. */
  | { kind: "reverted"; hash: Hex; code: string }
  /** Not broadcast or not admitted: the simulation reverted, or the chain refused the tx. */
  | { kind: "refused"; code: string; error: string; hash?: Hex }
  /** Unknown: the send errored after it may have reached the chain. Not resent. */
  | { kind: "error"; error: string; hash?: Hex };

export interface SweepChain {
  evmChainId(): Promise<number>;
  getCode(address: Hex): Promise<Hex>;
  latestBlock(): Promise<{ number: bigint; timestamp: bigint }>;
  /** FlightEscrow events from `address` in [fromBlock, toBlock], in log order. Reads may retry. */
  escrowEvents(address: Hex, fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]>;
  /** The address refund() txs are sent from. */
  senderAddress(): Hex;
  /** Send refund(bookingId) once. Must never retry a broadcast. */
  sendRefund(escrow: Hex, bookingId: Hex): Promise<RefundOutcome>;
}

// ------------------------------------------------------------------ the sweep

export const DIANA_EVM_CHAIN_ID = 9800;
/** Blocks per eth_getLogs request (public RPCs cap the range). */
export const LOG_SPAN = BigInt(5_000);

export interface SweepOptions {
  escrow: Hex;
  deployBlock: bigint;
  explorer: string;
  /** Strings that must never appear in output (mnemonic, private keys). */
  secrets: readonly string[];
  /** Where each output line goes (after the secret check). */
  print: (line: string) => void;
  /** Only list what would be refunded; send nothing. */
  dryRun?: boolean;
  logSpan?: bigint;
}

export interface SweepResult {
  refunded: { bookingId: Hex; hash: Hex }[];
  failed: { bookingId: Hex; outcome: Exclude<RefundOutcome, { kind: "refunded" }> }[];
  pending: LockedBooking[];
  settled: number;
}

export function describeRefund(o: RefundOutcome): string {
  switch (o.kind) {
    case "refunded":
      return `refunded ${o.hash}`;
    case "reverted":
      return `reverted (${o.code}) ${o.hash}`;
    case "refused":
      return `refused (${o.code})${o.hash ? ` ${o.hash}` : ""}: ${o.error}`;
    case "error":
      return `error, not resent (outcome unknown, check the explorer before running again)${o.hash ? ` ${o.hash}` : ""}: ${o.error}`;
  }
}

/**
 * Scan FlightEscrow's events from the deploy block, refund every Locked booking whose ticket
 * deadline has passed (one refund() each, never resent), and list the ones still in their
 * window. A failed refund is reported with its code and the sweep moves on to the next one.
 */
export async function runSweep(chain: SweepChain, opts: SweepOptions): Promise<SweepResult> {
  const say = (line: string) => {
    assertNoSecrets(line, opts.secrets);
    opts.print(line);
  };
  const id = await chain.evmChainId();
  if (id !== DIANA_EVM_CHAIN_ID) throw new Error(`EVM chain id is ${id}, expected ${DIANA_EVM_CHAIN_ID} (diana). Nothing sent.`);
  const code = await chain.getCode(opts.escrow);
  if (!code || code === "0x") throw new Error(`No contract at FLIGHT_ESCROW_ADDRESS ${opts.escrow}. Nothing sent.`);

  const head = await chain.latestBlock();
  if (opts.deployBlock > head.number) {
    throw new Error(`FLIGHT_ESCROW_DEPLOY_BLOCK ${opts.deployBlock} is after the latest block ${head.number}. Nothing sent.`);
  }
  const span = opts.logSpan ?? LOG_SPAN;
  const events: EscrowEvent[] = [];
  for (let from = opts.deployBlock; from <= head.number; from += span) {
    const to = from + span - BigInt(1) < head.number ? from + span - BigInt(1) : head.number;
    events.push(...(await chain.escrowEvents(opts.escrow, from, to)));
  }
  const { expired, pending, settled } = classifyBookings(events, head.timestamp);

  say(`FlightEscrow ${opts.escrow}: blocks ${opts.deployBlock}..${head.number}, ${settled} settled, ${expired.length} expired Locked, ${pending.length} still in their ticket window.`);
  for (const b of pending) {
    say(`  wait  ${b.bookingId}  ${formatQorWei(b.priceWei)}  refundable in ${formatRemaining(b.deadline - head.timestamp + BigInt(1))}`);
  }

  const result: SweepResult = { refunded: [], failed: [], pending, settled };
  if (expired.length === 0) {
    say("Nothing to refund.");
    return result;
  }
  if (opts.dryRun) {
    for (const b of expired) say(`  would refund ${b.bookingId}  ${formatQorWei(b.priceWei)} -> owner ${b.owner ?? "(recorded in the contract)"}`);
    say("Dry run: nothing sent.");
    return result;
  }

  say(`Sending refund() from ${chain.senderAddress()}; the contract pays each booking's owner.`);
  for (const b of expired) {
    let outcome: RefundOutcome;
    try {
      outcome = await chain.sendRefund(opts.escrow, b.bookingId);
    } catch (err) {
      outcome = { kind: "error", error: errorText(err) };
    }
    if (outcome.kind === "refunded") {
      result.refunded.push({ bookingId: b.bookingId, hash: outcome.hash });
      say(`  ok    ${b.bookingId}  ${formatQorWei(b.priceWei)} -> owner ${b.owner ?? "(recorded in the contract)"}`);
      say(`        tx ${outcome.hash}  ${explorerTxUrl(opts.explorer, outcome.hash)}`);
    } else {
      result.failed.push({ bookingId: b.bookingId, outcome });
      say(`  FAIL  ${b.bookingId}  ${describeRefund(outcome)}`);
      if ("hash" in outcome && outcome.hash) say(`        tx ${outcome.hash}  ${explorerTxUrl(opts.explorer, outcome.hash)}`);
    }
  }
  say(`Done: ${result.refunded.length} refunded, ${result.failed.length} failed, ${pending.length} waiting.`);
  return result;
}
