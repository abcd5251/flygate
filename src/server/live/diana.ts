import "server-only";
// Reuses the bootstrap's pure helpers (client, balance, rate-limit retry, connect). Never imports
// scripts/bootstrap/env.ts: that module generates and writes mnemonics (D-31).
import { classifyEvmWindowRejection, deriveUnifiedAccount, fetchEvmWindow, QoreHttpError, type UnifiedAccount } from "@qorechain/sdk";
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
import { balanceOf, makeClient, retrying } from "../../../scripts/bootstrap/chain";
import { deriveEvmRole } from "../../../scripts/evm/keys";
import { openSignerWindow } from "../../../scripts/live/eth-native";
import { decodePqcKeyStatus, encodePqcKeyStatusCall, PQC_KEY_STATUS_ADDRESS } from "../../../scripts/evm/pqcKeyStatus";
import type { BroadcastOutcome, EthCallResult, EvmLog, Hex, IncludedCosmosTx, ServerChain } from "./chain";
import type { LiveNetwork, LiveRole } from "./config";
import { signerWindowToOpen } from "./signer-window";

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

/** How often to ask for a Cosmos tx the owner's wallet broadcast. */
const TX_POLL_MS = 1_500;

/** GET /cosmos/tx/v1beta1/txs/{hash}: the tx once included, undefined while it is not (404). */
async function cosmosTxOnce(rest: string, hash: string): Promise<IncludedCosmosTx | undefined> {
  return retrying(async () => {
    const url = `${rest}/cosmos/tx/v1beta1/txs/${hash}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), cache: "no-store" });
    if (res.status === 404) return undefined;
    const body = (await res.json().catch(() => ({}))) as { tx_response?: { txhash: string; height: string; code: number; raw_log?: string }; message?: string };
    // Some nodes answer 400/500 with "tx not found" while the tx is still in the mempool.
    if (!res.ok) {
      if (/not found/i.test(body.message ?? "")) return undefined;
      // A QoreHttpError, so `retrying` retries a 429.
      throw new QoreHttpError(res.status, url, body.message);
    }
    const t = body.tx_response;
    if (!t) return undefined;
    return { hash: t.txhash, height: Number(t.height), code: t.code, rawLog: t.raw_log };
  });
}

/**
 * eth_call at latest. A JSON-RPC error that carries revert data (or says "reverted") is the
 * call's answer; anything else is an RPC error and throws. Retried on rate limiting only.
 */
async function evmCall(url: string, call: { from?: Hex; to: Hex; data: Hex; value?: bigint }): Promise<EthCallResult> {
  const params = [{ from: call.from, to: call.to, data: call.data, value: call.value === undefined ? undefined : toHexQty(call.value) }, "latest"];
  return retrying(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "eth_call", params }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`EVM RPC eth_call: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: Hex; error?: { code: number; message: string; data?: unknown } };
    if (body.error) {
      const data = typeof body.error.data === "string" && body.error.data.startsWith("0x") ? (body.error.data as Hex) : undefined;
      if (data || /revert/i.test(body.error.message)) return { status: "reverted", data: data ?? "0x", reason: body.error.message };
      throw new Error(`EVM RPC eth_call: ${body.error.message} (${body.error.code})`);
    }
    return { status: "success", data: body.result ?? "0x" };
  });
}

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
 * The real server-side chain: diana over @qorechain/sdk (REST) and EVM JSON-RPC (viem, coin-60
 * signers of FlyGate's agent). Keys are derived on first use from `mnemonics` and never leave
 * this module. Reads are retried on rate limiting; sends never are.
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
  const wallets = new Map<LiveRole, Promise<WalletClient>>();
  const unified = new Map<LiveRole, Promise<UnifiedAccount>>();

  function mnemonic(role: LiveRole): string {
    const m = mnemonics[role];
    if (!m) throw new Error(`No mnemonic for ${role}`);
    return m;
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
  /** The coin-60 signer as an eth-native Cosmos account (it signs its own MsgOpenEVMWindow). */
  function signerAccount(role: LiveRole): Promise<UnifiedAccount> {
    let u = unified.get(role);
    if (!u) {
      u = deriveUnifiedAccount(mnemonic(role));
      u.catch(() => unified.delete(role));
      unified.set(role, u);
    }
    return u;
  }

  /**
   * Opens an EVM window on `role`'s signer unless the open one covers this tx. Undefined when the
   * tx may be sent; otherwise the failed window tx's outcome (never resent, the EVM tx is not sent).
   */
  async function ensureSignerWindow(role: LiveRole, to: Hex, value: bigint, maxFeePerGas: bigint, timeoutMs: number): Promise<BroadcastOutcome | undefined> {
    const lane = "cosmos" as const;
    let who: UnifiedAccount;
    let open: ReturnType<typeof signerWindowToOpen>;
    try {
      who = await signerAccount(role);
      const current = await retrying(() => fetchEvmWindow({ rest: network.rest, address: who.cosmos }));
      open = signerWindowToOpen(current, { to, value }, maxFeePerGas);
    } catch (err) {
      return { status: "failed", lane, code: "evm window unknown", reason: `Could not read the ${role} signer's EVM window: ${errorText(err)}` };
    }
    if (!open) return undefined;
    try {
      await within(openSignerWindow({ client, rest: network.rest, chainId: network.chainId }, who, open), timeoutMs);
      return undefined;
    } catch (err) {
      if (err instanceof Timeout) return { status: "timeout", lane, code: "evm window timeout", reason: `${role} signer window: ${err.message}` };
      return { status: "failed", lane, code: "evm window open failed", reason: `${role} signer window: ${errorText(err)}` };
    }
  }

  return {
    async evmChainId() {
      return Number(await evmRead<string>(url, "eth_chainId", []));
    },
    async getCode(address) {
      return evmRead<Hex>(url, "eth_getCode", [address, "latest"]);
    },
    async pqcKeyStatus(address) {
      const ret = await evmRead<Hex>(url, "eth_call", [
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
    ethCall(req) {
      return evmCall(url, req);
    },
    async cosmosTx(hash, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tx = await cosmosTxOnce(network.rest, hash);
        if (tx || Date.now() + TX_POLL_MS > deadline) return tx;
        await new Promise((r) => setTimeout(r, TX_POLL_MS));
      }
    },

    async sendEvm(from, req, opts): Promise<BroadcastOutcome> {
      const lane = "evm" as const;
      const deadline = Date.now() + opts.timeoutMs;
      const value = req.value ?? BigInt(0);
      let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
      try {
        fees = await retrying(() => pub.estimateFeesPerGas());
      } catch (err) {
        return { status: "failed", lane, code: "rpc error", reason: `Could not read EVM fees: ${errorText(err)}` };
      }
      // The signer's own window must admit this tx; the fees it was sized for are the tx's.
      const windowFailure = await ensureSignerWindow(from, req.to, value, fees.maxFeePerGas, opts.timeoutMs);
      if (windowFailure) return windowFailure;
      let hash: Hex;
      try {
        const w = await wallet(from);
        // viem estimates gas first: a revert there means nothing was broadcast.
        hash = await within(
          w.sendTransaction({ account: w.account!, chain: evmChain, to: req.to, data: req.data, value, ...fees }),
          Math.max(1, deadline - Date.now()),
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
