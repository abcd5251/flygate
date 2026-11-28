import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, decodeFunctionData, type Hex } from "viem";
import type { CancelResult, CheckoutQuote } from "@/lib/chain";
import { cancelMessage, DIANA_CHAIN_ID, FLIGHT_ESCROW_ABI, SELECTORS, verifyMessage } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import type { ChainTx } from "@/lib/types";
import type { EthCallRequest, EvmTxRequest } from "./chain";
import { CANCEL_REASON_OFFER_UNAVAILABLE } from "./cancel";
import { readLiveConfig } from "./config";
import type { FakeChain } from "./fake-chain";
import { createLiveService } from "./service";
import { env, ESCROW, healthyChain, roles, SESSION_KEY } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");

function service(chain: FakeChain) {
  return createLiveService({ chain, config: readLiveConfig(env()), clock: { now: () => NOW_MS } });
}
type Svc = ReturnType<typeof service>;

const quoteOf = async (svc: Svc, scenario = "order_fail") =>
  (await svc.checkout({ step: "quote", offerId: "off_fa802", scenario, mandate: defaultMandate(), owner: (await roles).owner.cosmos, sessionKey: SESSION_KEY })) as CheckoutQuote & { ok: true; bookingId: Hex };
const lockOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "lock", bookingId, sessionKey: SESSION_KEY })) as ChainTx;
const cancelOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "cancel", bookingId, sessionKey: SESSION_KEY })) as CancelResult;

/** Booking fails as the page runs it: quote, verify, lock, (Duffel fails, simulated), cancel. */
async function bookingFails(svc: Svc) {
  const q = await quoteOf(svc);
  assert.equal(q.ok, true);
  await svc.checkout({ step: "verify", bookingId: q.bookingId });
  const lock = await lockOf(svc, q.bookingId);
  const cancel = await cancelOf(svc, q.bookingId);
  return { q, lock, cancel };
}

/** mandateOf reads (the owner's budget) after the cancel() broadcast. */
function balanceReadsAfterCancel(chain: FakeChain) {
  const sent = chain.callsTo("sendEvm").at(-1);
  const from = sent ? chain.calls.indexOf(sent) : chain.calls.length;
  return chain.calls.slice(from + 1).filter((c) => c.method === "ethCall" && (c.args[0] as EthCallRequest).data.startsWith(SELECTORS.mandateOf));
}

function decodeCancel(tx: EvmTxRequest) {
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: tx.data });
  assert.equal(d.functionName, "cancel");
  const [proof, signature] = d.args as unknown as [{ bookingId: Hex; reasonCode: number }, Hex];
  return { proof, signature };
}

test("Booking fails: exactly 2 broadcasts, book then cancel() from the agent EOA with a merchant-signed CancelProof (reasonCode 1)", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const { q, lock, cancel } = await bookingFails(service(chain));

  const sent = chain.broadcasts();
  assert.deepEqual(sent.map((c) => [c.method, c.args[0]]), [["sendEvm", "agent"], ["sendEvm", "agent"]]);
  assert.equal(lock.ok, true);

  const tx = sent[1].args[1] as EvmTxRequest;
  assert.equal(tx.to, ESCROW);
  assert.equal(tx.value ?? BigInt(0), BigInt(0));
  const { proof, signature } = decodeCancel(tx);
  assert.equal(proof.bookingId, q.bookingId);
  assert.equal(proof.reasonCode, 1);
  assert.equal(CANCEL_REASON_OFFER_UNAVAILABLE, 1);
  // Signed with the merchant's registered ML-DSA-87 key over the domain-bound CANCEL message.
  const msg = cancelMessage(proof, { chainId: DIANA_CHAIN_ID, escrow: ESCROW });
  assert.equal(verifyMessage(bytesToHex(r.merchantPqc.publicKey), signature, msg), true);

  assert.equal(cancel.tx.ok, true);
  assert.equal(cancel.tx.source, "live");
  assert.equal(cancel.tx.kind, "merchant", "the merchant's signature is the authority (D-19)");
  assert.equal(cancel.tx.lane, "evm");
  assert.match(cancel.tx.msg, /FlightEscrow\.cancel\(\) · submitted by agent/);
  assert.equal(cancel.tx.explorerUrl, `https://explore.qore.network/tx/${cancel.tx.hash}`);
});

test("after cancel() one read of the owner's budget in FlightEscrow, where the refund goes (ADR-0003)", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const { cancel } = await bookingFails(service(chain));
  const owner = r.owner.evm;

  const reads = balanceReadsAfterCancel(chain);
  assert.equal(reads.length, 1, "one read, after the cancel tx");
  const { args } = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: (reads[0].args[0] as EthCallRequest).data });
  assert.deepEqual(args, [owner, r.agent.signer.address]);

  assert.equal(cancel.refundTo, owner);
  assert.equal(cancel.balanceQor, "10 QOR", "the fixture's budget");
  assert.equal(cancel.readResult, `mandateOf(owner ${owner}).budget → 10 QOR`);
});

test("the same (cancel, bookingId) twice broadcasts once, also when the calls overlap", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  await lockOf(svc, q.bookingId);
  const [a, b] = await Promise.all([cancelOf(svc, q.bookingId), cancelOf(svc, q.bookingId)]);
  const c = await cancelOf(svc, q.bookingId);
  assert.equal(chain.callsTo("sendEvm").length, 2, "book() and one cancel()");
  assert.equal(balanceReadsAfterCancel(chain).length, 1);
  assert.equal(a.tx.hash, b.tx.hash);
  assert.equal(a.tx.hash, c.tx.hash);
});

test("a failed cancel() is never resent and reads no balance", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  await lockOf(svc, q.bookingId);
  chain.state.outcomes.push({ mode: "revert", code: "evm revert", reason: "BadStatus()" });
  const first = await cancelOf(svc, q.bookingId);
  const again = await cancelOf(svc, q.bookingId);
  assert.equal(first.tx.ok, false);
  assert.equal(first.tx.code, "evm revert");
  assert.equal(first.tx.explorerUrl, undefined, "a failure is never a Live tx");
  assert.equal(again.tx.id, first.tx.id);
  assert.equal(chain.callsTo("sendEvm").length, 2, "book() and one cancel()");
  assert.equal(balanceReadsAfterCancel(chain).length, 0);
});

test("a failed budget read keeps the refund tx and says the read failed", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  await lockOf(svc, q.bookingId);
  chain.state.fail.ethCall = new Error("429 Too Many Requests");
  const cancel = await cancelOf(svc, q.bookingId);
  assert.equal(cancel.tx.ok, true);
  assert.equal(cancel.readResult, undefined);
  assert.match(cancel.readError ?? "", /429/);
});

test("nothing is sent before book() succeeded or for an unknown booking; refusals can be retried", async () => {
  const chain = await healthyChain();
  const svc = service(chain);

  const unknown = await cancelOf(svc, `0x${"ab".repeat(32)}`);
  assert.equal(unknown.tx.code, "unknown booking");

  const q = await quoteOf(svc);
  const early = await cancelOf(svc, q.bookingId);
  assert.equal(early.tx.code, "out of order");
  assert.equal(early.tx.hash, "");

  assert.equal(chain.callsTo("sendEvm").length, 0);

  // The refusal was not cached: once book() succeeds, cancel() goes out.
  await lockOf(svc, q.bookingId);
  const later = await cancelOf(svc, q.bookingId);
  assert.equal(later.tx.ok, true);
  assert.equal(chain.callsTo("sendEvm").length, 2, "book() and cancel()");
});
