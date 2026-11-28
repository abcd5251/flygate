// `pnpm live:sweep` - refund FlightEscrow bookings stuck in Locked after a Live demo failed past
// `lock` (#25, D-26). Scans Booked / Released / Refunded from FLIGHT_ESCROW_DEPLOY_BLOCK, calls
// refund() once for each Locked booking whose ticket deadline has passed (refund() returns the
// price to the owner the contract recorded, whoever sends it: to the owner's budget, or straight
// to the owner once they closed the mandate), and lists the ones still in their window.
//
// Sends REAL diana transactions from the dev owner key's coin-60 signer, only as a fee payer.
// Each refund() is simulated first (a revert there sends nothing) and broadcast once, never resent. If diana refuses it because the signer has no ML-DSA-87 key or
// no open window, the sweep fixes that cause once (register the key / open a window scoped to
// FlightEscrow) and sends a NEW refund(); any other failure prints its code and the sweep moves
// on to the next booking.
//
// Reads FLIGHT_ESCROW_ADDRESS, FLIGHT_ESCROW_DEPLOY_BLOCK and OWNER_MNEMONIC from the env or
// .env.local, read-only. No key material is printed: every line passes assertNoSecrets first.
//
// Flags: --yes (skip the confirmation), --dry-run (list what would be refunded, send nothing).
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { classifyEvmWindowRejection, deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeClient, retrying } from "../bootstrap/chain";
import { deriveEvmRole } from "../evm/keys";
import { openSignerWindow, registerSignerPqc, type EthNativeCtx } from "./eth-native";
import { assertNoSecrets, errorText, type Hex } from "./probe-lib";
import {
  DIANA_EVM_CHAIN_ID,
  decodeEscrowLog,
  readSweepEnv,
  REFUND_ABI,
  runSweep,
  type EscrowEvent,
  type RefundOutcome,
  type SweepChain,
  type SweepEnv,
} from "./sweep-lib";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = join(ROOT, ".env.local");

/** refund() plus the errors it can revert with, so a simulation names the reason. */
const REFUND_CALL_ABI = [
  ...REFUND_ABI,
  ...parseAbi(["error NotLocked(bytes32 bookingId)", "error TicketDeadlineNotPassed(bytes32 bookingId)", "error TransferFailed()"]),
];
/** A window just for the sweep: ~10 minutes, refund() calls on FlightEscrow only. */
const SWEEP_WINDOW = { blocks: 600, maxTxs: 20, maxValue: "1000000" };
const RECEIPT_TIMEOUT_MS = 60_000;

let SECRETS: string[] = [];
function say(line = ""): void {
  assertNoSecrets(line, SECRETS);
  console.log(line);
}

/** The diana implementation: viem for EVM reads and the refund() send, the SDK for window/PQC. */
function dianaSweepChain(env: SweepEnv, signerKey: Hex, unified: UnifiedAccount): SweepChain {
  const chain = defineChain({
    id: DIANA_EVM_CHAIN_ID,
    name: "qorechain-diana",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [env.evmRpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(env.evmRpc) }) as PublicClient;
  const account = privateKeyToAccount(signerKey);
  // retryCount 0: a send is never retried.
  const wallet = createWalletClient({ account, chain, transport: http(env.evmRpc, { retryCount: 0 }) });
  const cosmos: EthNativeCtx = { client: makeClient({ chainId: env.chainId, rest: env.rest, rpc: env.rpc, evmRpc: env.evmRpc, explorer: env.explorer }), rest: env.rest, chainId: env.chainId };
  const fixed = { pqc: false, window: false };

  async function sendOnce(escrow: Hex, bookingId: Hex): Promise<Hex> {
    return wallet.writeContract({ address: escrow, abi: REFUND_CALL_ABI, functionName: "refund", args: [bookingId], chain });
  }

  return {
    evmChainId: () => retrying(() => pub.getChainId()),
    getCode: async (address) => ((await retrying(() => pub.getCode({ address }))) ?? "0x") as Hex,
    async latestBlock() {
      const b = await retrying(() => pub.getBlock({ blockTag: "latest" }));
      return { number: b.number, timestamp: b.timestamp };
    },
    async escrowEvents(address, fromBlock, toBlock) {
      const logs = await retrying(() => pub.getLogs({ address, fromBlock, toBlock }));
      return logs.map(decodeEscrowLog).filter((e): e is EscrowEvent => e !== undefined);
    },
    senderAddress: () => account.address,
    async sendRefund(escrow, bookingId): Promise<RefundOutcome> {
      // Simulate first: a revert here means nothing is broadcast.
      try {
        await retrying(() => pub.simulateContract({ account: account.address, address: escrow, abi: REFUND_CALL_ABI, functionName: "refund", args: [bookingId] }));
      } catch (err) {
        const reverted = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : undefined;
        const code = reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? "reverted") : "simulation-failed";
        return { kind: "refused", code, error: `simulation: ${errorText(err)}` };
      }

      let hash: Hex | undefined;
      for (;;) {
        try {
          hash = await sendOnce(escrow, bookingId);
          break;
        } catch (err) {
          const rejection = classifyEvmWindowRejection(err);
          if (!rejection) return { kind: "error", error: errorText(err) };
          // Fix the refusal's cause once per run, then send a NEW tx (not a resend of a refused one).
          try {
            if (rejection === "no-pqc-key" && !fixed.pqc) {
              fixed.pqc = true;
              say(`        signer has no ML-DSA-87 key: registered it in ${await registerSignerPqc(cosmos, unified)}`);
              continue;
            }
            if ((rejection === "no-window" || rejection === "exhausted") && !fixed.window) {
              fixed.window = true;
              say(`        signer window ${rejection}: opened one for FlightEscrow in ${await openSignerWindow(cosmos, unified, { ...SWEEP_WINDOW, allowedTargets: [escrow] })}`);
              continue;
            }
          } catch (fixErr) {
            return { kind: "refused", code: rejection, error: `fixing it failed: ${errorText(fixErr)}` };
          }
          return { kind: "refused", code: rejection, error: errorText(err) };
        }
      }

      try {
        const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        return r.status === "success" ? { kind: "refunded", hash } : { kind: "reverted", hash, code: "reverted" };
      } catch (err) {
        return { kind: "error", hash, error: `no receipt yet: ${errorText(err)}` };
      }
    },
  };
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((a) => a !== "--");
  const unknown = flags.filter((f) => f !== "--yes" && f !== "--dry-run");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: pnpm live:sweep [--yes] [--dry-run]`);
  const dryRun = flags.includes("--dry-run");

  const env = readSweepEnv(process.env, existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "");
  const owner = await deriveEvmRole("owner", env.ownerMnemonic);
  const unified = await deriveUnifiedAccount(env.ownerMnemonic);
  SECRETS = [env.ownerMnemonic, owner.signer.privateKey, unified.privateKey];
  if (unified.evm.toLowerCase() !== owner.signer.address.toLowerCase()) {
    throw new Error("owner: the unified eth-native account is not the coin-60 signer. Nothing sent.");
  }

  say(`live:sweep on ${env.chainId}: FlightEscrow ${env.escrow}, from block ${env.deployBlock}`);
  if (!dryRun && !flags.includes("--yes")) {
    say(`Expired Locked bookings get a real refund() tx from the owner signer ${owner.signer.address}.`);
    if (!process.stdin.isTTY) throw new Error("Not a terminal: pass --yes to confirm (or --dry-run). Nothing sent.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y") {
      say("Nothing sent.");
      return;
    }
  }

  const res = await runSweep(dianaSweepChain(env, owner.signer.privateKey, unified), {
    escrow: env.escrow,
    deployBlock: env.deployBlock,
    explorer: env.explorer,
    secrets: SECRETS,
    print: (line) => console.log(line),
    dryRun,
  });
  if (res.failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const text = errorText(err);
  try {
    assertNoSecrets(text, SECRETS);
    console.error(`\nlive:sweep failed: ${text}`);
  } catch {
    console.error("\nlive:sweep failed (the error text held key material and was withheld).");
  }
  process.exit(1);
});
