import "server-only";

/**
 * Live server settings, read from the server environment (`.env.local` via Next.js, never a
 * `NEXT_PUBLIC_` variable). Reading only: unlike scripts/bootstrap/env.ts this never generates or
 * writes a mnemonic. There is no fallback escrow address: Live is unavailable without one (D-02).
 */

export const LIVE_ROLES = ["owner", "agent", "merchant"] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];

/**
 * Who sends FlightEscrow.book() (D-09, D-11): the Linked agent key through MsgExecuteEVM from the
 * owner account ("authenticator"), or the agent's coin-60 EOA directly ("eoa", the fallback).
 */
export const BOOK_LANES = ["authenticator", "eoa"] as const;
export type BookLane = (typeof BOOK_LANES)[number];

export const MNEMONIC_VARS: Record<LiveRole, string> = {
  owner: "OWNER_MNEMONIC",
  agent: "AGENT_MNEMONIC",
  merchant: "MERCHANT_MNEMONIC",
};

export const LIVE_DEFAULTS = {
  chainId: "qorechain-diana",
  rpc: "https://rpc-testnet.qore.host",
  rest: "https://api-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
  explorer: "https://explore.qore.network",
  /** 1 US$ = 0.01 QOR (D-14). */
  qorPerUsd: "0.01",
} as const;

export interface LiveNetwork {
  chainId: string;
  rpc: string;
  rest: string;
  evmRpc: string;
  explorer: string;
}

export interface LiveConfig {
  /** `LIVE_MODE=on`. Every Live route answers 404 otherwise (D-08). */
  liveMode: boolean;
  /** Mnemonics that are set. Secrets: never log or return them. */
  mnemonics: Partial<Record<LiveRole, string>>;
  /** FLIGHT_ESCROW_ADDRESS exactly as set (validated by the status check), or undefined. */
  escrowAddress?: string;
  /** FLIGHT_ESCROW_DEPLOY_BLOCK, the first block to scan for FlightEscrow logs. */
  deployBlock?: bigint;
  /** uqor per US$ (LIVE_QOR_PER_USD in QOR, 6 decimals). */
  uqorPerUsd: bigint;
  /** LIVE_BOOK_LANE; defaults to "authenticator". */
  lane: BookLane;
  network: LiveNetwork;
  /** Settings that are set but unusable (the status check reports the first one). */
  problems: string[];
}

export type Env = Record<string, string | undefined>;

/** "0.01" QOR -> 10_000 uqor. Accepts up to 6 decimals; anything else is a config error. */
export function parseQorAmount(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a QOR amount with at most 6 decimals: "${value}"`);
  return BigInt(m[1]) * BigInt(1_000_000) + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function readLiveConfig(env: Env): LiveConfig {
  const get = (key: string) => {
    const v = env[key]?.trim();
    return v ? v : undefined;
  };
  const mnemonics: Partial<Record<LiveRole, string>> = {};
  for (const role of LIVE_ROLES) {
    const value = get(MNEMONIC_VARS[role]);
    if (value) mnemonics[role] = value;
  }
  const problems: string[] = [];
  const block = get("FLIGHT_ESCROW_DEPLOY_BLOCK");
  if (block && !/^\d+$/.test(block)) problems.push("FLIGHT_ESCROW_DEPLOY_BLOCK is not a block number");
  let uqorPerUsd = parseQorAmount(LIVE_DEFAULTS.qorPerUsd);
  const rate = get("LIVE_QOR_PER_USD");
  if (rate) {
    try {
      uqorPerUsd = parseQorAmount(rate);
      if (uqorPerUsd === BigInt(0)) problems.push("LIVE_QOR_PER_USD must be above 0");
    } catch {
      problems.push("LIVE_QOR_PER_USD is not a QOR amount (e.g. 0.01)");
    }
  }
  let lane: BookLane = "authenticator";
  const laneRaw = get("LIVE_BOOK_LANE");
  if (laneRaw) {
    if ((BOOK_LANES as readonly string[]).includes(laneRaw)) lane = laneRaw as BookLane;
    else problems.push(`LIVE_BOOK_LANE must be ${BOOK_LANES.join(" or ")}`);
  }
  return {
    liveMode: get("LIVE_MODE") === "on",
    mnemonics,
    escrowAddress: get("FLIGHT_ESCROW_ADDRESS"),
    deployBlock: block && /^\d+$/.test(block) ? BigInt(block) : undefined,
    uqorPerUsd,
    lane,
    problems,
    network: {
      chainId: get("QORE_CHAIN_ID") ?? LIVE_DEFAULTS.chainId,
      rpc: get("QORE_RPC_URL") ?? LIVE_DEFAULTS.rpc,
      rest: get("QORE_REST_URL") ?? LIVE_DEFAULTS.rest,
      evmRpc: get("QORE_EVM_RPC_URL") ?? LIVE_DEFAULTS.evmRpc,
      explorer: (get("QORE_EXPLORER_URL") ?? LIVE_DEFAULTS.explorer).replace(/\/+$/, ""),
    },
  };
}
