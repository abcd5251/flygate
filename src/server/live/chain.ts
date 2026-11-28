import "server-only";
import type { Abi } from "viem";
import type { TxLane } from "@/lib/types";
import type { PqcKeyStatus } from "../../../scripts/evm/pqcKeyStatus";
import type { LiveRole } from "./config";

export type Hex = `0x${string}`;
export type { PqcKeyStatus };

/** A plain EVM transaction; the signer is the sending role's coin-60 key. */
export interface EvmTxRequest {
  to: Hex;
  data: Hex;
  /** wei; defaults to 0. */
  value?: bigint;
  /** Decodes a custom-error revert into its name ("FareOverCap(...)") for the outcome's reason. */
  errorAbi?: Abi;
}

export interface BroadcastOptions {
  /** Longest wait for inclusion before the send counts as timed out (D-30). */
  timeoutMs: number;
}

/**
 * What happened to one broadcast. Only `success` may be shown as "Live tx" (D-20).
 * - `reverted`: included in a block but failed (Cosmos code != 0, EVM receipt reverted).
 * - `failed`: refused before inclusion (CheckTx, gas estimation revert) or an RPC error; it may
 *   or may not have landed, and it is never resent.
 * - `timeout`: no inclusion within `timeoutMs`; it may still land, and it is never resent.
 * `code` is the chain's error code ("abstractaccount 5", "evm revert", ...).
 */
export type BroadcastOutcome =
  | { status: "success"; lane: TxLane; hash: string; height?: number }
  | { status: "reverted" | "failed" | "timeout"; lane: TxLane; hash?: string; code: string; reason: string };

/** One EVM log, as eth_getLogs returns it. */
export interface EvmLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
}

export interface LogFilter {
  address: Hex;
  fromBlock: bigint;
  /** topic0..3; `null` matches anything. */
  topics: (Hex | null)[];
}

/** A read-only EVM call (eth_call at latest). Nothing is signed or sent. */
export interface EthCallRequest {
  to: Hex;
  data: Hex;
  /** msg.sender of the simulated call. */
  from?: Hex;
  /** wei. */
  value?: bigint;
}

/**
 * What an eth_call returned. A revert is an answer, not an error: `data` is the revert data
 * (decode it with the contract's error ABI). RPC failures throw instead.
 */
export type EthCallResult = { status: "success"; data: Hex } | { status: "reverted"; data: Hex; reason: string };

/** A Cosmos tx the owner's wallet sent, once included. */
export interface IncludedCosmosTx {
  hash: string;
  height: number;
  /** ABCI code; 0 = success. */
  code: number;
  rawLog?: string;
}

/**
 * The server-side chain interface the Live service depends on: everything it reads from and
 * sends to diana. The server only ever sends as FlyGate's own roles (agent, merchant); the
 * owner's transactions are signed and sent by the owner's wallet (ADR-0003). `createDianaChain` is the real one; tests use `FakeChain`.
 * Implementations retry reads on rate limiting only, and never retry a broadcast. Sends resolve
 * with a `BroadcastOutcome` and do not throw.
 */
export interface ServerChain {
  /** eth_chainId. */
  evmChainId(): Promise<number>;
  /** eth_getCode at latest; "0x" when nothing is deployed. */
  getCode(address: Hex): Promise<Hex>;
  /** pqcKeyStatus(address) on the 0x...0A02 precompile, as FlightEscrow reads it. */
  pqcKeyStatus(address: Hex): Promise<PqcKeyStatus>;
  /** Bank balance in uqor of a qor1 account. */
  bankBalance(cosmos: string): Promise<bigint>;
  /** EVM balance in wei of a 0x address. */
  evmBalance(address: Hex): Promise<bigint>;
  /** eth_getLogs from `fromBlock` to latest. Throws when the logs cannot be read in full. */
  getLogs(filter: LogFilter): Promise<EvmLog[]>;
  /** eth_call at latest. Resolves with the revert data when the call reverts; throws on RPC errors. */
  ethCall(req: EthCallRequest): Promise<EthCallResult>;
  /**
   * Waits up to `timeoutMs` for a Cosmos tx someone else broadcast (the owner's QoreX wallet) to
   * be included. Resolves undefined when it is not included in time; throws on RPC errors.
   */
  cosmosTx(hash: string, timeoutMs: number): Promise<IncludedCosmosTx | undefined>;
  /**
   * One EVM tx from `from`'s coin-60 signer; waits for the receipt. Lane "evm", 0x hash. First
   * opens an EVM window on that signer when the open one does not admit the tx (docs/FLOW.md);
   * a failed window tx is the outcome (lane "cosmos") and the EVM tx is then not sent.
   */
  sendEvm(from: LiveRole, tx: EvmTxRequest, opts: BroadcastOptions): Promise<BroadcastOutcome>;
}
