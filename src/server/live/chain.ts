import "server-only";
import type { Abi } from "viem";
import type { TxLane } from "@/lib/types";
import type { PqcKeyStatus } from "../../../scripts/evm/pqcKeyStatus";
import type { LiveRole } from "./config";

export type Hex = `0x${string}`;
export type { PqcKeyStatus };

/** A Cosmos message as @qorechain/sdk builds it (`EncodeObject`). */
export interface CosmosMsg {
  typeUrl: string;
  value: unknown;
}

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
  /**
   * Cosmos only: the tx carries MsgExecuteEVM / MsgExecuteCosmos. Code 0 can still be a failed
   * authorised execution, so its results are checked and a failure is `reverted` (D-09).
   */
  authenticatorExecutions?: boolean;
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

/** Which MsgExecuteEVM digest diana verifies (`resolveEvmAuthDigestVersion`). */
export type EvmAuthDigestVersion = "v1" | "v2";

/** A key linked to an account (abstractaccount authenticators). */
export interface LinkedKey {
  /** Lowercase hex without 0x (a 20-byte ETH address for scheme secp256k1 links). */
  pubkeyHex: string;
  revoked: boolean;
  expiryUnix: number;
}

/**
 * The server-side chain interface the Live service depends on: everything it reads from and
 * sends to diana. `createDianaChain` is the real one; tests use `FakeChain`.
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
  /** Keys linked to a qor1 account, revoked ones included; none before the account's first link creates it. */
  linkedKeys(cosmos: string): Promise<LinkedKey[]>;
  /** eth_call at latest. Resolves with the revert data when the call reverts; throws on RPC errors. */
  ethCall(req: EthCallRequest): Promise<EthCallResult>;
  /**
   * The sequence the next MsgExecuteEVM from linked key `pubkey` (a 0x ETH address) acting for
   * `account` (qor1) must carry (`fetchAuthNonce`). Not the account's EVM nonce.
   */
  authNonce(account: string, pubkey: Hex): Promise<bigint>;
  /** The MsgExecuteEVM digest diana verifies now (`resolveEvmAuthDigestVersion`); never guessed. */
  evmAuthDigestVersion(): Promise<EvmAuthDigestVersion>;
  /**
   * One Cosmos tx from `from`'s bootstrap account (coin 118, qor1), hybrid-signed with its
   * registered ML-DSA-87 key; waits for inclusion. Lane "cosmos", Cosmos hash.
   */
  sendCosmos(from: LiveRole, messages: CosmosMsg[], opts: BroadcastOptions): Promise<BroadcastOutcome>;
  /** One EVM tx from `from`'s coin-60 signer; waits for the receipt. Lane "evm", 0x hash. */
  sendEvm(from: LiveRole, tx: EvmTxRequest, opts: BroadcastOptions): Promise<BroadcastOutcome>;
}
