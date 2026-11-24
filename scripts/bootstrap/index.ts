// `pnpm bootstrap` - get the FlyGate diana testnet accounts ready. Every step is idempotent.
//   (default)      full bootstrap
//   --check-only   read chain state and print the verification table; sends nothing
import { resolve } from "node:path";
import { PqcKeyMismatchError, type QoreChainClient } from "@qorechain/sdk";
import { ROLES, loadEnv, type NetworkSettings, type Role } from "./env";
import {
  balanceOf,
  connect,
  deriveRole,
  formatQor,
  makeClient,
  pqcStatusOf,
  registerPqc,
  type RoleAccount,
} from "./chain";
import { printReport, type AccountRow, type SentTx } from "./report";

const ENV_PATH = resolve(import.meta.dirname, "../../.env.local");
const FAUCET_URL = "https://dashboard.qorechain.io/faucet";
const FAUCET_POLL_MS = 2000;

type Mode = "bootstrap" | "check-only";

interface Context {
  network: NetworkSettings;
  client: QoreChainClient;
  accounts: Record<Role, RoleAccount>;
  /** Every transaction this run sent, in order. */
  txs: SentTx[];
}

function parseMode(argv: string[]): Mode {
  const flags = argv.filter((a) => a !== "--");
  const unknown = flags.filter((a) => a !== "--check-only");
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: pnpm bootstrap [--check-only]`);
  return flags.includes("--check-only") ? "check-only" : "bootstrap";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Block until the owner holds testnet QOR. The faucet needs a manual dashboard login. */
async function waitForOwnerFunds(ctx: Context): Promise<void> {
  const { address } = ctx.accounts.owner;
  let balance = await balanceOf(ctx.client, address);
  if (balance > BigInt(0)) return;

  console.log(`\nOwner has no QOR. Fund it from the faucet (log in, 100 QOR per 24h):`);
  console.log(`  faucet: ${FAUCET_URL}`);
  console.log(`  owner:  ${address}`);
  console.log(`Polling every ${FAUCET_POLL_MS / 1000}s. Ctrl-C is safe; rerun to resume.`);
  while (balance === BigInt(0)) {
    await sleep(FAUCET_POLL_MS);
    balance = await balanceOf(ctx.client, address);
  }
  console.log(`Owner funded: ${formatQor(balance)}`);
}

async function registerOwnerPqc(ctx: Context): Promise<void> {
  const owner = ctx.accounts.owner;
  const tx = await connect(ctx.client, owner);
  try {
    const res = await registerPqc(ctx.network, tx, owner);
    if (res.alreadyRegistered) {
      console.log("Owner ML-DSA-87 key already registered; skipping.");
    } else if (res.txHash) {
      console.log(`Owner ML-DSA-87 key registered: ${res.txHash}`);
      ctx.txs.push({ label: "owner PQC registration", hash: res.txHash });
    }
  } finally {
    tx.disconnect();
  }
}

async function collectRows(ctx: Context, roles: readonly Role[]): Promise<AccountRow[]> {
  const rows: AccountRow[] = [];
  for (const role of roles) {
    const { address } = ctx.accounts[role];
    rows.push({
      role,
      address,
      balance: await balanceOf(ctx.client, address),
      pqc: await pqcStatusOf(ctx.network, address),
    });
  }
  return rows;
}

/** Roles shown in the verification table. Only the owner is bootstrapped so far. */
const REPORTED_ROLES: readonly Role[] = ["owner"];

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const env = loadEnv(ENV_PATH);
  if (env.generated.length > 0) {
    console.log(`Generated mnemonic(s) for ${env.generated.join(", ")} -> ${ENV_PATH}`);
  }

  const accounts = {} as Record<Role, RoleAccount>;
  for (const role of ROLES) accounts[role] = await deriveRole(role, env.mnemonics[role]);
  const ctx: Context = { network: env.network, client: makeClient(env.network), accounts, txs: [] };

  if (mode === "bootstrap") {
    await waitForOwnerFunds(ctx);
    await registerOwnerPqc(ctx);
  }

  printReport(ctx.network.explorer, await collectRows(ctx, REPORTED_ROLES), ctx.txs);
}

process.on("SIGINT", () => {
  console.log("\nInterrupted. Nothing is left half-done; rerun `pnpm bootstrap` to resume.");
  process.exit(130);
});

main().catch((err: unknown) => {
  if (err instanceof PqcKeyMismatchError) {
    console.error(
      `\nPQC key mismatch for ${err.address}: the chain holds a different ML-DSA-87 key than the one ` +
        `derived from this mnemonic. Stopping. Check that the mnemonic in .env.local is the one that ` +
        `registered this account (or rotate the key on chain).`,
    );
  } else {
    console.error(`\nBootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
