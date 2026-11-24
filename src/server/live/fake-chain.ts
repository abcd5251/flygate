import "server-only";
import { decodeFunctionData, encodeFunctionResult, hexToBytes } from "viem";
import { PQC_VERIFY_ABI, PQC_VERIFY_ADDRESS, verifyMessage } from "@/lib/escrow";
import type {
  BroadcastOptions,
  BroadcastOutcome,
  CosmosMsg,
  EthCallRequest,
  EthCallResult,
  EvmAuthDigestVersion,
  EvmLog,
  EvmTxRequest,
  Hex,
  LinkedKey,
  LogFilter,
  PqcKeyStatus,
  ServerChain,
} from "./chain";
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
  /** Linked keys per qor1 account. */
  linked: Record<string, LinkedKey[]>;
  /** Authenticator sequence per `${qor1}/${lowercase 0x pubkey}`; missing means 0. */
  authNonces: Record<string, bigint>;
  digestVersion: EvmAuthDigestVersion;
  /**
   * Answers eth_call. The default runs pqcVerify for real (ML-DSA-87 over the call's arguments)
   * and returns "0x" for anything else.
   */
  ethCall?: (req: EthCallRequest) => EthCallResult;
  /** Make a method throw this error (an RPC failure). For sends, prefer `outcomes`. */
  fail: Partial<Record<keyof ServerChain, Error>>;
  /** How each broadcast ends, in order; once empty, broadcasts succeed. */
  outcomes: FakeBroadcastSpec[];
}

const NOT_REGISTERED: PqcKeyStatus = { registered: false, algorithmId: 0, pubkey: new Uint8Array(), possessionProven: false };

const DEFAULT_FAILURE: Record<Exclude<FakeBroadcastMode, "success">, { code: string; reason: string }> = {
  revert: { code: "evm revert", reason: "execution reverted" },
  timeout: { code: "timeout", reason: "not included in time" },
  failed: { code: "broadcast failed", reason: "rpc error" },
};

const BROADCASTS: ReadonlySet<keyof ServerChain> = new Set(["sendCosmos", "sendEvm"]);

/**
 * Test double for the server-side chain interface. Records every call in order, answers reads
 * from `state`, and ends each broadcast as `state.outcomes` says (success by default).
 * Hashes are deterministic: Cosmos ones uppercase hex, EVM ones 0x-prefixed.
 */
export class FakeChain implements ServerChain {
  readonly calls: FakeCall[] = [];
  readonly state: FakeChainState;
  private sent = 0;

  constructor(state: Partial<FakeChainState> = {}) {
    this.state = { chainId: 9800, code: {}, pqc: {}, bank: {}, evm: {}, logs: [], linked: {}, authNonces: {}, digestVersion: "v2", fail: {}, outcomes: [], ...state };
  }

  private record(method: keyof ServerChain, args: unknown[]) {
    this.calls.push({ method, args });
    const err = this.state.fail[method];
    if (err) throw err;
  }

  callsTo(method: keyof ServerChain): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Every sendCosmos / sendEvm, in order. */
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
  async linkedKeys(cosmos: string) {
    this.record("linkedKeys", [cosmos]);
    return this.state.linked[cosmos] ?? [];
  }
  async ethCall(req: EthCallRequest) {
    this.record("ethCall", [req]);
    return this.state.ethCall ? this.state.ethCall(req) : defaultEthCall(req);
  }
  async authNonce(account: string, pubkey: Hex) {
    this.record("authNonce", [account, pubkey]);
    return this.state.authNonces[`${account}/${pubkey.toLowerCase()}`] ?? BigInt(0);
  }
  async evmAuthDigestVersion() {
    this.record("evmAuthDigestVersion", []);
    return this.state.digestVersion;
  }
  async sendCosmos(from: LiveRole, messages: CosmosMsg[], opts: BroadcastOptions) {
    this.record("sendCosmos", [from, messages, opts]);
    return this.outcome("cosmos");
  }
  async sendEvm(from: LiveRole, tx: EvmTxRequest, opts: BroadcastOptions) {
    this.record("sendEvm", [from, tx, opts]);
    return this.outcome("evm");
  }

  private outcome(lane: "cosmos" | "evm"): BroadcastOutcome {
    this.sent += 1;
    const n = this.sent.toString(16).padStart(64, "0");
    const hash = lane === "cosmos" ? n.toUpperCase() : `0x${n}`;
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
function defaultEthCall(req: EthCallRequest): EthCallResult {
  if (req.to.toLowerCase() !== PQC_VERIFY_ADDRESS) return { status: "success", data: "0x" };
  const { args } = decodeFunctionData({ abi: PQC_VERIFY_ABI, data: req.data });
  const [pubkey, signature, message] = args as [Hex, Hex, Hex];
  const ok = verifyMessage(pubkey, signature, hexToBytes(message));
  return { status: "success", data: encodeFunctionResult({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", result: ok }) };
}
