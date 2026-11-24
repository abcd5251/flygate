// Read-only EVM JSON-RPC calls against diana. Nothing here signs or broadcasts.
import { resolve } from "node:path";
import { retrying } from "../bootstrap/chain";
import { loadEnv, ROLES, type NetworkSettings, type Role } from "../bootstrap/env";
import { deriveEvmRole, type EvmRole, type Hex } from "./keys";
import { decodePqcKeyStatus, encodePqcKeyStatusCall, PQC_KEY_STATUS_ADDRESS, type PqcKeyStatus } from "./pqcKeyStatus";

export const DIANA_EVM_CHAIN_ID = 9800;
/** 1 uqor (6 decimals, bank) = 1e12 wei (18 decimals, EVM). */
export const WEI_PER_UQOR = BigInt(1_000_000_000_000);

export const ENV_PATH = resolve(import.meta.dirname, "../../.env.local");

export interface EvmSetup {
  network: NetworkSettings;
  mnemonics: Record<Role, string>;
  roles: Record<Role, EvmRole>;
}

/** Read `.env.local` and derive every role's EVM account and signer. Never generates keys. */
export async function loadEvmSetup(envPath: string = ENV_PATH): Promise<EvmSetup> {
  const env = loadEnv(envPath);
  if (env.generated.length > 0) {
    throw new Error(`No mnemonic for ${env.generated.join(", ")} (one was just generated). Run \`pnpm bootstrap\` first.`);
  }
  const roles = {} as Record<Role, EvmRole>;
  for (const role of ROLES) roles[role] = await deriveEvmRole(role, env.mnemonics[role]);
  return { network: env.network, mnemonics: env.mnemonics, roles };
}

let nextId = 1;

export async function evmRpc<T = string>(url: string, method: string, params: unknown[]): Promise<T> {
  return retrying(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!res.ok) throw new Error(`EVM RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`EVM RPC ${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  });
}

export async function evmChainId(url: string): Promise<number> {
  return Number(await evmRpc(url, "eth_chainId", []));
}

/** Balance in wei (18 decimals). */
export async function evmBalance(url: string, address: Hex): Promise<bigint> {
  return BigInt(await evmRpc(url, "eth_getBalance", [address, "latest"]));
}

/** `pqcKeyStatus(address)` on 0x...0A02 via eth_call, exactly as FlightEscrow reads it. */
export async function pqcKeyStatusOnEvm(url: string, address: Hex): Promise<PqcKeyStatus> {
  const ret = await evmRpc(url, "eth_call", [
    { to: PQC_KEY_STATUS_ADDRESS, data: encodePqcKeyStatusCall(address) },
    "latest",
  ]);
  return decodePqcKeyStatus(ret);
}
