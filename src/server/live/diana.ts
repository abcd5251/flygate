import "server-only";
// Reuses the bootstrap's pure helpers (client, balance, rate-limit retry, connect). Never imports
// scripts/bootstrap/env.ts: that module generates and writes mnemonics (D-31).
import {
  assertAuthenticatorExecutionsSucceeded,
  AuthenticatorExecutionError,
  classifyEvmWindowRejection,
  fetchAuthenticators,
  QoreTxError,
  type TxClient,
} from "@qorechain/sdk";
import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  http,
  WaitForTransactionReceiptTimeoutError,
  type Abi,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { balanceOf, connect, deriveRole, makeClient, retrying } from "../../../scripts/bootstrap/chain";
import { deriveEvmRole } from "../../../scripts/evm/keys";
import { decodePqcKeyStatus, encodePqcKeyStatusCall, PQC_KEY_STATUS_ADDRESS } from "../../../scripts/evm/pqcKeyStatus";
import type { BroadcastOutcome, CosmosMsg, EvmLog, Hex, ServerChain } from "./chain";
import type { LiveNetwork, LiveRole } from "./config";

/** Longest a single read may take before it counts as an RPC error. */
const READ_TIMEOUT_MS = 10_000;
/** eth_getLogs block range per request (public RPCs commonly cap the range). */
const LOG_CHUNK_BLOCKS = BigInt(10_000);
const DIANA_EVM_CHAIN_ID = 9800;

let nextId = 1;

/** One EVM JSON-RPC read, retried on rate limiting only (bootstrap rule). Never use for a send. */
async function evmRead<T>(url: string, method: string, params: unknown[]): Promise<T> {
  return retrying(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`EVM RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`EVM RPC ${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  });
}

const toHexQty = (n: bigint) => `0x${n.toString(16)}`;

function errorText(err: unknown): string {
  const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  return msg.split("\n").slice(0, 3).join(" ").slice(0, 400);
}

/** The custom error name of a reverted EVM call, when its data decodes with `abi`. */
function revertName(err: unknown, abi?: Abi): string | undefined {
  if (!(err instanceof BaseError) || !abi) return undefined;
  const withData = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
  if (!withData?.data || withData.data === "0x") return undefined;
  try {
    const decoded = decodeErrorResult({ abi, data: withData.data });
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return undefined;
  }
}

class Timeout extends Error {}

/** Resolves with `p`, or rejects with Timeout after `ms` (the send itself keeps going, unresent). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout(`not included within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * The real server-side chain: diana over @qorechain/sdk (REST, hybrid-signed Cosmos txs) and EVM
 * JSON-RPC (viem, coin-60 signers). Keys are derived on first use from `mnemonics` and never
 * leave this module. Reads are retried on rate limiting; sends never are.
 */
export function createDianaChain(network: LiveNetwork, mnemonics: Partial<Record<LiveRole, string>>): ServerChain {
  const client = makeClient(network);
  const url = network.evmRpc;
  const evmChain = defineChain({
    id: DIANA_EVM_CHAIN_ID,
    name: network.chainId,
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  // retryCount 0: viem must never resend a transaction.
  const pub = createPublicClient({ chain: evmChain, transport: http(url, { retryCount: 0 }) }) as PublicClient;
  const txClients = new Map<LiveRole, Promise<TxClient>>();
  const wallets = new Map<LiveRole, Promise<WalletClient>>();

  function mnemonic(role: LiveRole): string {
    const m = mnemonics[role];
    if (!m) throw new Error(`No mnemonic for ${role}`);
    return m;
  }
  function txClient(role: LiveRole): Promise<TxClient> {
    let c = txClients.get(role);
    if (!c) {
      c = deriveRole(role, mnemonic(role)).then((who) => connect(client, who));
      c.catch(() => txClients.delete(role));
      txClients.set(role, c);
    }
    return c;
  }
  function wallet(role: LiveRole): Promise<WalletClient> {
    let w = wallets.get(role);
    if (!w) {
      w = deriveEvmRole(role, mnemonic(role)).then((r) =>
        createWalletClient({ account: privateKeyToAccount(r.signer.privateKey), chain: evmChain, transport: http(url, { retryCount: 0 }) }),
      );
      wallets.set(role, w);
    }
    return w;
  }

  return {
    async evmChainId() {
      return Number(await evmRead<string>(url, "eth_chainId", []));
    },
    async getCode(address) {
      return evmRead<Hex>(url, "eth_getCode", [address, "latest"]);
    },
    async pqcKeyStatus(address) {
      const ret = await evmRead<string>(url, "eth_call", [
        { to: PQC_KEY_STATUS_ADDRESS, data: encodePqcKeyStatusCall(address) },
        "latest",
      ]);
      return decodePqcKeyStatus(ret);
    },
    bankBalance(cosmos) {
      return balanceOf(client, cosmos);
    },
    async evmBalance(address) {
      return BigInt(await evmRead<string>(url, "eth_getBalance", [address, "latest"]));
    },
    async getLogs({ address, fromBlock, topics }) {
      const latest = BigInt(await evmRead<string>(url, "eth_blockNumber", []));
      const out: EvmLog[] = [];
      for (let from = fromBlock; from <= latest; from += LOG_CHUNK_BLOCKS) {
        const to = from + LOG_CHUNK_BLOCKS - BigInt(1) < latest ? from + LOG_CHUNK_BLOCKS - BigInt(1) : latest;
        type RawLog = { address: Hex; topics: Hex[]; data: Hex; blockNumber: string; transactionHash: Hex };
        const logs = await evmRead<RawLog[]>(url, "eth_getLogs", [{ address, fromBlock: toHexQty(from), toBlock: toHexQty(to), topics }]);
        for (const l of logs) out.push({ ...l, blockNumber: BigInt(l.blockNumber) });
      }
      return out;
    },
    async linkedKeys(cosmos) {
      const keys = await retrying(() => fetchAuthenticators({ rest: network.rest, address: cosmos }));
      return keys.map((k) => ({
        pubkeyHex: k.pubkeyHex.toLowerCase().replace(/^0x/, ""),
        revoked: k.revoked,
        expiryUnix: Number(k.expiryUnix),
      }));
    },

    async sendCosmos(from, messages, opts): Promise<BroadcastOutcome> {
      const lane = "cosmos" as const;
      let tx: TxClient;
      try {
        tx = await txClient(from);
      } catch (err) {
        return { status: "failed", lane, code: "connect failed", reason: errorText(err) };
      }
      try {
        // Broadcast once ("commit" waits for inclusion); never retried.
        const res = await within(tx.signAndBroadcast(messages as CosmosMsg[] as Parameters<TxClient["signAndBroadcast"]>[0], "auto"), opts.timeoutMs);
        if (res.code !== 0) {
          return { status: "reverted", lane, hash: res.transactionHash, code: `code ${res.code}`, reason: res.rawLog ?? "" };
        }
        if (opts.authenticatorExecutions) {
          try {
            assertAuthenticatorExecutionsSucceeded(res, messages as Parameters<typeof assertAuthenticatorExecutionsSucceeded>[1]);
          } catch (err) {
            if (err instanceof AuthenticatorExecutionError) {
              const reason = err.failed.map((f) => f.reason || f.vmError).join("; ");
              return { status: "reverted", lane, hash: res.transactionHash, code: "execution failed", reason };
            }
            throw err;
          }
        }
        return { status: "success", lane, hash: res.transactionHash, height: res.height };
      } catch (err) {
        if (err instanceof Timeout) return { status: "timeout", lane, code: "timeout", reason: err.message };
        if (err instanceof QoreTxError) {
          return { status: "failed", lane, hash: err.txHash, code: `${err.codespace} ${err.code}`.trim(), reason: errorText(err) };
        }
        return { status: "failed", lane, code: "broadcast failed", reason: errorText(err) };
      }
    },

    async sendEvm(from, req, opts): Promise<BroadcastOutcome> {
      const lane = "evm" as const;
      const deadline = Date.now() + opts.timeoutMs;
      let hash: Hex;
      try {
        const w = await wallet(from);
        // viem estimates gas first: a revert there means nothing was broadcast.
        hash = await within(
          w.sendTransaction({ account: w.account!, chain: evmChain, to: req.to, data: req.data, value: req.value ?? BigInt(0) }),
          opts.timeoutMs,
        );
      } catch (err) {
        if (err instanceof Timeout) return { status: "timeout", lane, code: "timeout", reason: err.message };
        const window = classifyEvmWindowRejection(err);
        if (window) return { status: "failed", lane, code: `evm window ${window}`, reason: errorText(err) };
        const name = revertName(err, req.errorAbi);
        return { status: "failed", lane, code: name ? "evm revert" : "broadcast failed", reason: name ?? errorText(err) };
      }
      try {
        const receipt = await pub.waitForTransactionReceipt({ hash, timeout: Math.max(1, deadline - Date.now()), retryCount: 0 });
        if (receipt.status !== "success") return { status: "reverted", lane, hash, code: "evm revert", reason: "receipt status reverted" };
        return { status: "success", lane, hash, height: Number(receipt.blockNumber) };
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return { status: "timeout", lane, hash, code: "timeout", reason: errorText(err) };
        return { status: "failed", lane, hash, code: "receipt unknown", reason: errorText(err) };
      }
    },
  };
}
