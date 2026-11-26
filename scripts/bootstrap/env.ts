// Local env file (.env.local): network config plus one mnemonic per role.
// Reads and appends by hand (no dotenv). Existing values are never overwritten.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { generateMnemonic, validateMnemonic } from "@qorechain/sdk";

export const ROLES = ["owner", "agent", "merchant"] as const;
export type Role = (typeof ROLES)[number];

const MNEMONIC_KEY: Record<Role, string> = {
  owner: "OWNER_MNEMONIC",
  agent: "AGENT_MNEMONIC",
  merchant: "MERCHANT_MNEMONIC",
};

export const NETWORK_DEFAULTS = {
  QORE_CHAIN_ID: "qorechain-diana",
  QORE_RPC_URL: "https://rpc-testnet.qore.host",
  QORE_REST_URL: "https://api-testnet.qore.host",
  QORE_EVM_RPC_URL: "https://evm-testnet.qore.host",
  QORE_EXPLORER_URL: "https://explore.qore.network",
} as const;

export interface NetworkSettings {
  chainId: string;
  rpc: string;
  rest: string;
  evmRpc: string;
  explorer: string;
}

export interface BootstrapEnv {
  network: NetworkSettings;
  mnemonics: Record<Role, string>;
  /** Roles whose mnemonic was generated (and written) by this run. */
  generated: Role[];
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env.local`, generating and appending any missing role mnemonic.
 * Lookup order per key: process env, then the file, then the diana default.
 */
export function loadEnv(path: string): BootstrapEnv {
  const file = parseEnvFile(path);
  const get = (key: string): string | undefined => process.env[key] || file[key] || undefined;

  const mnemonics = {} as Record<Role, string>;
  const generated: Role[] = [];
  const additions: string[] = [];
  for (const role of ROLES) {
    const key = MNEMONIC_KEY[role];
    const existing = get(key);
    if (existing) {
      if (!validateMnemonic(existing)) {
        throw new Error(`${key} in ${path} is not a valid BIP-39 mnemonic. Fix or remove it.`);
      }
      mnemonics[role] = existing;
    } else {
      mnemonics[role] = generateMnemonic(256);
      generated.push(role);
      additions.push(`${key}="${mnemonics[role]}"`);
    }
  }

  for (const [key, value] of Object.entries(NETWORK_DEFAULTS)) {
    if (!(key in file)) additions.push(`${key}=${value}`);
  }

  if (additions.length > 0) {
    const header = "# Written by `pnpm bootstrap`. Holds secrets: never commit.\n";
    if (!existsSync(path)) {
      writeFileSync(path, header + additions.join("\n") + "\n", { mode: 0o600 });
    } else {
      const current = readFileSync(path, "utf8");
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      appendFileSync(path, sep + additions.join("\n") + "\n");
    }
  }

  return {
    network: {
      chainId: get("QORE_CHAIN_ID") ?? NETWORK_DEFAULTS.QORE_CHAIN_ID,
      rpc: get("QORE_RPC_URL") ?? NETWORK_DEFAULTS.QORE_RPC_URL,
      rest: get("QORE_REST_URL") ?? NETWORK_DEFAULTS.QORE_REST_URL,
      evmRpc: get("QORE_EVM_RPC_URL") ?? NETWORK_DEFAULTS.QORE_EVM_RPC_URL,
      explorer: (get("QORE_EXPLORER_URL") ?? NETWORK_DEFAULTS.QORE_EXPLORER_URL).replace(/\/+$/, ""),
    },
    mnemonics,
    generated,
  };
}
