import "server-only";
// Reuses the bootstrap's pure helpers (client, balance, rate-limit retry). Never imports
// scripts/bootstrap/env.ts: that module generates and writes mnemonics (D-31).
import { balanceOf, makeClient, retrying } from "../../../scripts/bootstrap/chain";
import { decodePqcKeyStatus, encodePqcKeyStatusCall, PQC_KEY_STATUS_ADDRESS } from "../../../scripts/evm/pqcKeyStatus";
import type { Hex, ServerChain } from "./chain";
import type { LiveNetwork } from "./config";

/** Longest a single read may take before it counts as an RPC error. */
const READ_TIMEOUT_MS = 10_000;

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

/** The real server-side chain: diana over @qorechain/sdk (REST) and EVM JSON-RPC. */
export function createDianaChain(network: LiveNetwork): ServerChain {
  const client = makeClient(network);
  const url = network.evmRpc;
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
  };
}
