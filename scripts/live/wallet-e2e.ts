// `pnpm live:e2e-wallet [baseUrl]` - the whole Live flow against a running FlyGate (`pnpm dev`),
// with a stand-in for the owner's QoreX wallet (ADR-0003). Sends SMALL REAL diana transactions.
//
// The stand-in is the OWNER_MNEMONIC account from .env.local: a secp256k1 qor1 account with a
// registered ML-DSA-87 key, like a QoreX account. It does what QoreX's signAndBroadcast does: it
// takes the messages /api/live/mandate built (protobuf bytes), signs them hybrid and broadcasts.
// FlyGate's server never sees this key. Then it drives /api/live/checkout as the page would:
//   1. mandate: prepare -> wallet tx (deposit + openMandate) -> confirm
//   2. Ticketed: quote, verify, lock (book from the budget), proof (merchant paid)
//   3. Booking fails: quote, verify, lock, cancel (refund back to the budget)
//   4. a quote from another session is refused
//   5. close: closeMandate -> the unspent budget returns to the wallet
// Prints every tx with its explorer link, and the gas each wallet tx used.
import { join, resolve } from "node:path";
import { qorechainRegistry, waitForTx } from "@qorechain/sdk";
import { keccak256, type Hex } from "viem";
import type { CancelResult, CheckoutQuote, ClosePlan, MandatePlan, OwnerState, QuoteCheck, TicketProofResult, WalletRequest } from "../../src/lib/chain";
import { defaultMandate } from "../../src/lib/mandate";
import type { ChainTx, Mandate } from "../../src/lib/types";
import { balanceOf, connect, deriveRole, makeClient } from "../bootstrap/chain";
import { assertNoSecrets, readProbeEnvFrom } from "./probe-lib";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = process.argv[2] ?? "http://localhost:3000";
const OFFER = "off_fa802";
const PNR = "K7Q2XM";

let SECRETS: string[] = [];
function say(line: string): void {
  assertNoSecrets(line, SECRETS);
  console.log(line);
}
function fail(what: string, detail: unknown): never {
  throw new Error(`${what}: ${JSON.stringify(detail)}`);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function randomKey(): Hex {
  return `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as Hex;
}

async function main(): Promise<void> {
  const env = readProbeEnvFrom(join(ROOT, ".env.local"));
  SECRETS = [env.mnemonics.owner];
  const owner = await deriveRole("owner", env.mnemonics.owner);
  const client = makeClient(env.network);
  const registry = qorechainRegistry();
  const wallet = await connect(client, owner);

  /** What QoreX does with a request: decode nothing it was not given, sign hybrid, broadcast once. */
  async function walletSend(req: WalletRequest, what: string): Promise<string> {
    const msgs = req.messages.map((m) => ({ typeUrl: m.typeUrl, value: registry.decode({ typeUrl: m.typeUrl, value: new Uint8Array(Buffer.from(m.value, "base64")) }) }));
    const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(req.gasLimit * 0.15)) }], gas: String(req.gasLimit) };
    const res = await wallet.signAndBroadcast(msgs, fee, req.memo);
    if (res.code !== 0) fail(`${what} wallet tx`, { code: res.code, hash: res.transactionHash, log: res.rawLog });
    const included = await waitForTx(client.rest, res.transactionHash, { timeoutMs: 60_000 });
    say(`  wallet tx ${res.transactionHash} · gas used ${res.gasUsed} of ${req.gasLimit} · height ${included.height}`);
    return res.transactionHash;
  }

  const status = await (await fetch(`${BASE}/api/live/status`)).json();
  if (!status.available) fail("Live unavailable", status.reason);
  say(`Live on ${BASE}: FlightEscrow ${status.escrow}, agent ${status.addresses.agent.signer}`);
  say(`owner (stand-in QoreX account) ${owner.address}, balance ${await balanceOf(client, owner.address)} uqor`);

  // 1. mandate
  const mandate: Mandate = { ...defaultMandate(), expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), maxTickets: 2 };
  const sessionKey = randomKey();
  const controlHash = keccak256(sessionKey);
  say("\n1. mandate");
  const plan = await post<MandatePlan>("/api/live/mandate", { action: "prepare", mandate, owner: owner.address, controlHash });
  if (!plan.ok) fail("prepare", plan);
  say(`  deposit ${plan.depositQor} QOR, budget after ${plan.budgetQor} QOR, ${plan.request.messages.map((m) => m.typeUrl.split(".").pop()).join(" + ")}`);
  const openHash = await walletSend(plan.request, "openMandate");
  const opened = await post<ChainTx>("/api/live/mandate", { action: "confirm", mandate, owner: owner.address, controlHash, txHash: openHash });
  if (!opened.ok) fail("confirm", opened);
  say(`  confirmed: ${opened.explorerUrl}`);

  const session = { owner: owner.address, sessionKey };
  const step = <T>(body: Record<string, unknown>) => post<T>("/api/live/checkout", { ...body, sessionKey });

  async function book(scenario: "normal" | "order_fail") {
    const q = await step<CheckoutQuote>({ step: "quote", offerId: OFFER, scenario, mandate, ...session });
    if (!q.ok || !q.bookingId) fail(`${scenario} quote`, q);
    const v = await step<QuoteCheck>({ step: "verify", bookingId: q.bookingId });
    if (!v.ok) fail(`${scenario} verify`, v);
    const lock = await step<ChainTx>({ step: "lock", bookingId: q.bookingId });
    if (!lock.ok) fail(`${scenario} lock`, lock);
    say(`  quote ${q.priceQor} QOR · ${v.readResult}\n  lock: ${lock.explorerUrl}`);
    return q.bookingId;
  }

  // 2. Ticketed
  say("\n2. Ticketed");
  const ticketed = await book("normal");
  const proof = await step<TicketProofResult>({ step: "proof", bookingId: ticketed, pnr: PNR });
  if (!proof.proof.ok) fail("proof", proof.proof);
  say(`  proof + payout: ${proof.proof.explorerUrl}`);

  // 3. Booking fails
  say("\n3. Booking fails");
  const failing = await book("order_fail");
  const cancel = await step<CancelResult>({ step: "cancel", bookingId: failing });
  if (!cancel.tx.ok) fail("cancel", cancel.tx);
  say(`  cancel: ${cancel.tx.explorerUrl} · ${cancel.readResult}`);

  // 4. another session cannot drive the agent
  say("\n4. another session");
  const other = await post<CheckoutQuote>("/api/live/checkout", { step: "quote", offerId: OFFER, scenario: "normal", mandate, owner: owner.address, sessionKey: randomKey() });
  if (other.ok || other.code !== "not your session") fail("other session was not refused", other);
  say(`  refused: ${other.code}`);

  // 5. close
  say("\n5. close");
  const close = await post<ClosePlan>("/api/live/mandate", { action: "close", owner: owner.address });
  if (!close.ok) fail("close", close);
  const before = await balanceOf(client, owner.address);
  const closeHash = await walletSend(close.request, "closeMandate");
  const closed = await post<ChainTx>("/api/live/mandate", { action: "closed", owner: owner.address, txHash: closeHash });
  if (!closed.ok) fail("closed", closed);
  const after = await balanceOf(client, owner.address);
  const state = await post<OwnerState>("/api/live/mandate", { action: "state", owner: owner.address });
  say(`  closed: ${closed.explorerUrl} · ${close.refundQor} QOR back (wallet ${before} -> ${after} uqor, after the fee)`);
  say(`  mandate now: ${JSON.stringify(state.ok ? state.mandate : state)}`);
  say("\nAll Live steps passed.");
}

main().catch((err) => {
  const text = err instanceof Error ? err.message : String(err);
  try {
    assertNoSecrets(text, SECRETS);
    console.error(`\nlive:e2e-wallet failed: ${text}`);
  } catch {
    console.error("\nlive:e2e-wallet failed (message withheld: it contained key material)");
  }
  process.exitCode = 1;
});
