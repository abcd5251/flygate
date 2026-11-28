import "server-only";
import { decodeFunctionData, encodeFunctionResult, hexToBytes } from "viem";
import { FLIGHT_ESCROW_ABI, PQC_VERIFY_ABI, PQC_VERIFY_ADDRESS, SELECTORS, verifyMessage } from "@/lib/escrow";
import type { BroadcastOptions, BroadcastOutcome, EthCallRequest, EthCallResult, EvmLog, EvmTxRequest, Hex, IncludedCosmosTx, LogFilter, PqcKeyStatus, ServerChain } from "./chain";
import type { LiveRole } from "./config";

export type FakeCall = { method: keyof ServerChain; args: unknown[] };

/** How the next broadcast ends. `code` / `reason` override the defaults of a failing mode. */
export type FakeBroadcastMode = "success" | "revert" | "timeout" | "failed";
export type FakeBroadcastSpec = FakeBroadcastMode | { mode: FakeBroadcastMode; code?: string; reason?: string };

export interface FakeChainState {
  chainId: number;
  /** Code per lowercase address; missing means "0x". */
  code: Record<string, Hex>;
  /** pqcKeyStatus per lowercase address; missing means not registered. */
  pqc: Record<string, PqcKeyStatus>;
  /** uqor per qor1 address. */
  bank: Record<string, bigint>;
  /** wei per lowercase 0x address. */
  evm: Record<string, bigint>;
  /** Every log on the chain; getLogs filters them. */
  logs: EvmLog[];
  /**
   * FlightEscrow.mandateOf answers, keyed `${owner}/${agent}` (lowercase 0x); missing means no
   * mandate. Read by the default eth_call for any contract address.
   */
  mandates: Record<string, FakeMandate>;
  /** Cosmos txs the owner's wallet sent, by uppercase hash; missing means not included (yet). */
  cosmosTxs: Record<string, IncludedCosmosTx>;
  /**
   * Answers eth_call, except FlightEscrow.mandateOf (from `mandates`). The default runs pqcVerify
   * for real (ML-DSA-87 over the call's arguments) and returns "0x" for anything else.
   */
  ethCall?: (req: EthCallRequest) => EthCallResult;
  /** Make a method throw this error (an RPC failure). For sends, prefer `outcomes`. */
  fail: Partial<Record<keyof ServerChain, Error>>;
  /** How each broadcast ends, in order; once empty, broadcasts succeed. */
  outcomes: FakeBroadcastSpec[];
}

/** One (owner, agent) slot of FlightEscrow, as mandateOf returns it. */
export interface FakeMandate {
  revoked?: boolean;
  ticketsUsed?: number;
  budgetWei: bigint;
  mandateHash: Hex;
  maxFareWei?: bigint;
  maxTickets?: number;
  /** unix seconds */
  expiresAt: bigint;
}

const NOT_REGISTERED: PqcKeyStatus = { registered: false, algorithmId: 0, pubkey: new Uint8Array(), possessionProven: false };

const DEFAULT_FAILURE: Record<Exclude<FakeBroadcastMode, "success">, { code: string; reason: string }> = {
  revert: { code: "evm revert", reason: "execution reverted" },
  timeout: { code: "timeout", reason: "not included in time" },
  failed: { code: "broadcast failed", reason: "rpc error" },
};

const BROADCASTS: ReadonlySet<keyof ServerChain> = new Set(["sendEvm"]);

/**
 * Test double for the server-side chain interface. Records every call in order, answers reads
 * from `state`, and ends each broadcast as `state.outcomes` says (success by default).
 * Hashes are deterministic and 0x-prefixed.
 */
export class FakeChain implements ServerChain {
  readonly calls: FakeCall[] = [];
  readonly state: FakeChainState;
  private sent = 0;

  constructor(state: Partial<FakeChainState> = {}) {
    this.state = { chainId: 9800, code: {}, pqc: {}, bank: {}, evm: {}, logs: [], mandates: {}, cosmosTxs: {}, fail: {}, outcomes: [], ...state };
  }

  private record(method: keyof ServerChain, args: unknown[]) {
    this.calls.push({ method, args });
    const err = this.state.fail[method];
    if (err) throw err;
  }

  callsTo(method: keyof ServerChain): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Every sendEvm, in order. */
  broadcasts(): FakeCall[] {
    return this.calls.filter((c) => BROADCASTS.has(c.method));
  }

  async evmChainId() {
    this.record("evmChainId", []);
    return this.state.chainId;
  }
  async getCode(address: Hex) {
    this.record("getCode", [address]);
    return this.state.code[address.toLowerCase()] ?? "0x";
  }
  async pqcKeyStatus(address: Hex) {
    this.record("pqcKeyStatus", [address]);
    return this.state.pqc[address.toLowerCase()] ?? NOT_REGISTERED;
  }
  async bankBalance(cosmos: string) {
    this.record("bankBalance", [cosmos]);
    return this.state.bank[cosmos] ?? BigInt(0);
  }
  async evmBalance(address: Hex) {
    this.record("evmBalance", [address]);
    return this.state.evm[address.toLowerCase()] ?? BigInt(0);
  }
  async getLogs(filter: LogFilter) {
    this.record("getLogs", [filter]);
    return this.state.logs.filter(
      (log) =>
        log.address.toLowerCase() === filter.address.toLowerCase() &&
        log.blockNumber >= filter.fromBlock &&
        filter.topics.every((t, i) => t === null || log.topics[i]?.toLowerCase() === t.toLowerCase()),
    );
  }
  async ethCall(req: EthCallRequest) {
    this.record("ethCall", [req]);
    // mandateOf always comes from `mandates`; `ethCall` answers every other call.
    if (req.data.startsWith(SELECTORS.mandateOf)) return mandateOfCall(this.state.mandates, req);
    return this.state.ethCall ? this.state.ethCall(req) : defaultEthCall(req);
  }
  async cosmosTx(hash: string, timeoutMs: number) {
    this.record("cosmosTx", [hash, timeoutMs]);
    return this.state.cosmosTxs[hash.toUpperCase()];
  }
  async sendEvm(from: LiveRole, tx: EvmTxRequest, opts: BroadcastOptions) {
    this.record("sendEvm", [from, tx, opts]);
    return this.outcome();
  }

  private outcome(): BroadcastOutcome {
    const lane = "evm" as const;
    this.sent += 1;
    const hash = `0x${this.sent.toString(16).padStart(64, "0")}`;
    const next = this.state.outcomes.shift() ?? "success";
    const spec = typeof next === "string" ? { mode: next } : next;
    if (spec.mode === "success") return { status: "success", lane, hash };
    const d = DEFAULT_FAILURE[spec.mode];
    const status = spec.mode === "revert" ? "reverted" : spec.mode;
    return {
      status,
      lane,
      hash: spec.mode === "failed" ? undefined : hash,
      code: spec.code ?? d.code,
      reason: spec.reason ?? d.reason,
    };
  }
}

/** pqcVerify answered for real; every other eth_call succeeds with no data. */
export function defaultEthCall(req: EthCallRequest): EthCallResult {
  if (req.to.toLowerCase() !== PQC_VERIFY_ADDRESS) return { status: "success", data: "0x" };
  const { args } = decodeFunctionData({ abi: PQC_VERIFY_ABI, data: req.data });
  const [pubkey, signature, message] = args as [Hex, Hex, Hex];
  const ok = verifyMessage(pubkey, signature, hexToBytes(message));
  return { status: "success", data: encodeFunctionResult({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", result: ok }) };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

/** FlightEscrow.mandateOf(owner, agent) answered from `mandates`. */
export function mandateOfCall(mandates: Record<string, FakeMandate>, req: EthCallRequest): EthCallResult {
  const { args } = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: req.data });
  const [owner, agent] = args as unknown as [Hex, Hex];
  const m = mandates[`${owner.toLowerCase()}/${agent.toLowerCase()}`];
  const result = {
    exists: !!m,
    revoked: m?.revoked ?? false,
    ticketsUsed: m?.ticketsUsed ?? 0,
    budget: m?.budgetWei ?? BigInt(0),
    mandate: {
      merchant: ZERO_ADDRESS as Hex,
      maxFareWei: m?.maxFareWei ?? BigInt(0),
      maxTickets: m?.maxTickets ?? 0,
      expiresAt: m?.expiresAt ?? BigInt(0),
      origin: "0x000000" as Hex,
      destination: "0x000000" as Hex,
      departFrom: 0,
      departTo: 0,
      cabin: 0,
      refundableOnly: false,
      mandateHash: m?.mandateHash ?? ZERO_HASH,
    },
  };
  return { status: "success", data: encodeFunctionResult({ abi: FLIGHT_ESCROW_ABI, functionName: "mandateOf", result }) };
}
