import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, pad, type Hex } from "viem";
import type { BookingStateResult, CheckoutQuote } from "@/lib/chain";
import { bookingId, Cabin, encodeBook, FLIGHT_ESCROW_ABI, type Quote } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import { DEMO_OFFERS } from "@/lib/offers";
import { readLiveConfig, type Env } from "./config";
import type { EvmLog } from "./chain";
import type { FakeChain } from "./fake-chain";
import { handleLiveCheckout } from "./http";
import { createLiveService } from "./service";
import { DEPLOY_BLOCK, env, ESCROW, healthyChain, roles } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");
const OFFER = DEMO_OFFERS.find((o) => o.id === "off_fa802")!;
const ID = `0x${"ab".repeat(32)}` as Hex;
const OTHER = `0x${"cd".repeat(32)}` as Hex;
const AGENT = "0x2222222222222222222222222222222222222222" as Hex;
const MERCHANT = "0x3333333333333333333333333333333333333333" as Hex;
const DEADLINE = 1_796_000_600;

function service(chain: FakeChain, e: Env = env()) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now: () => NOW_MS } });
}
const stateOf = async (chain: FakeChain, id: string = ID, e?: Env) => (await service(chain, e).checkout({ step: "state", bookingId: id })) as BookingStateResult;

let n = 0;
function log(topics: Hex[], data: Hex, address: Hex = ESCROW as Hex): EvmLog {
  n += 1;
  return { address, topics, data, blockNumber: DEPLOY_BLOCK + BigInt(n), transactionHash: `0x${n.toString(16).padStart(64, "0")}` };
}
const booked = (id: Hex) =>
  log(
    encodeEventTopics({ abi: FLIGHT_ESCROW_ABI, eventName: "Booked", args: { bookingId: id, agent: AGENT, merchant: MERCHANT } }) as Hex[],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [BigInt(3_890_000) * BigInt(10) ** BigInt(12), BigInt(DEADLINE)]),
  );
const released = (id: Hex) =>
  log(encodeEventTopics({ abi: FLIGHT_ESCROW_ABI, eventName: "Released", args: { bookingId: id } }) as Hex[], encodeAbiParameters([{ type: "bytes32" }], [`0x${"11".repeat(32)}`]));
const refunded = (id: Hex) =>
  log(encodeEventTopics({ abi: FLIGHT_ESCROW_ABI, eventName: "Refunded", args: { bookingId: id } }) as Hex[], encodeAbiParameters([{ type: "uint8" }], [0]));

function assertOk(r: BookingStateResult): asserts r is Extract<BookingStateResult, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
}

test("booking state: None when the booking has no events, and nothing is broadcast", async () => {
  const chain = await healthyChain();
  chain.state.logs.push(booked(OTHER));
  const r = await stateOf(chain);
  assertOk(r);
  assert.equal(r.state, "None");
  assert.equal(r.source, "live");
  assert.equal(r.bookingId, ID);
  assert.equal(r.booked, undefined);
  assert.equal(chain.broadcasts().length, 0);
  // One read from the deploy block, filtered on the bookingId topic.
  const reads = chain.callsTo("getLogs");
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].args[0], { address: ESCROW, fromBlock: DEPLOY_BLOCK, topics: [null, ID] });
});

test("booking state: Locked after Booked, with the Booked tx and the refund deadline", async () => {
  const chain = await healthyChain();
  const b = booked(ID);
  chain.state.logs.push(b, released(OTHER));
  const r = await stateOf(chain);
  assertOk(r);
  assert.equal(r.state, "Locked");
  assert.equal(r.booked?.hash, b.transactionHash);
  assert.equal(r.booked?.explorerUrl, `https://explore.qore.network/tx/${b.transactionHash}`);
  assert.equal(r.deadline, DEADLINE);
  assert.equal(chain.broadcasts().length, 0);
});

test("booking state: Released after Booked + Released", async () => {
  const chain = await healthyChain();
  const rel = released(ID);
  chain.state.logs.push(booked(ID), rel);
  const r = await stateOf(chain);
  assertOk(r);
  assert.equal(r.state, "Released");
  assert.equal(r.released?.hash, rel.transactionHash);
  assert.equal(chain.broadcasts().length, 0);
});

test("booking state: Refunded after Booked + Refunded", async () => {
  const chain = await healthyChain();
  const ref = refunded(ID);
  chain.state.logs.push(booked(ID), ref);
  const r = await stateOf(chain);
  assertOk(r);
  assert.equal(r.state, "Refunded");
  assert.equal(r.refunded?.hash, ref.transactionHash);
  assert.equal(chain.broadcasts().length, 0);
});

test("booking state: logs of another contract are not this booking's", async () => {
  const chain = await healthyChain();
  chain.state.logs.push(log(booked(ID).topics, "0x", "0x9999999999999999999999999999999999999999"));
  const r = await stateOf(chain);
  assertOk(r);
  assert.equal(r.state, "None");
});

test("booking state: unreadable logs or no deploy block is an honest failure, not None", async () => {
  const chain = await healthyChain();
  chain.state.fail.getLogs = new Error("429 too many requests");
  const r = await stateOf(chain);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "rpc error");

  const noBlock = await healthyChain();
  const r2 = await stateOf(noBlock, ID, env({ FLIGHT_ESCROW_DEPLOY_BLOCK: "" }));
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.code, "state unknown");
  assert.equal(noBlock.callsTo("getLogs").length, 0);

  const down = await healthyChain();
  const r3 = await stateOf(down, ID, env({ FLIGHT_ESCROW_ADDRESS: "" }));
  assert.equal(!r3.ok && r3.code, "live unavailable");
  for (const c of [chain, noBlock, down]) assert.equal(c.broadcasts().length, 0);
});

// ------------------------------------------------------------------ book() via the linked agent key

/** A quote booked through MsgExecuteEVM: its Booked log never reaches eth_getLogs. */
const QUOTE: Quote = {
  merchant: MERCHANT,
  agent: AGENT,
  owner: AGENT,
  offerId: pad("0x01", { size: 32 }),
  priceWei: BigInt(389) * BigInt(10) ** BigInt(16),
  origin: "TPE",
  destination: "NRT",
  departDay: 20807,
  cabin: Cabin.Economy,
  refundable: true,
  expiresAt: BigInt(1_800_000_000),
  ticketWindow: 600,
};
const EXEC_ID = bookingId(QUOTE);
const EXEC_HASH = "BECF62A723D7F8C08C8242D23E6C54571D80C717B8414B547008789C7C65F313";

async function executedChain() {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.executed[r.owner.account.cosmos] = [
    { hash: "AA".repeat(32), height: DEPLOY_BLOCK + BigInt(1), to: ESCROW as Hex, data: encodeBook({ ...QUOTE, expiresAt: BigInt(1) }, "0x01"), valueWei: QUOTE.priceWei, timeUnix: 0 },
    { hash: EXEC_HASH, height: DEPLOY_BLOCK + BigInt(2), to: ESCROW as Hex, data: encodeBook(QUOTE, "0x01"), valueWei: QUOTE.priceWei, timeUnix: 0 },
  ];
  return chain;
}

test("booking state: a book() sent through the linked agent key is Locked, with its Cosmos tx", async () => {
  const chain = await executedChain();
  const r = await stateOf(chain, EXEC_ID);
  assertOk(r);
  assert.equal(r.state, "Locked");
  assert.equal(r.booked?.hash, EXEC_HASH);
  assert.equal(r.booked?.explorerUrl, `https://explore.qore.network/tx/${EXEC_HASH}`);
  assert.equal(chain.broadcasts().length, 0);
});

test("booking state: Released and Refunded still come from the escrow's logs", async () => {
  const chain = await executedChain();
  const rel = released(EXEC_ID);
  chain.state.logs.push(rel);
  const r = await stateOf(chain, EXEC_ID);
  assertOk(r);
  assert.equal(r.state, "Released");
  assert.equal(r.booked?.hash, EXEC_HASH);
  assert.equal(r.released?.hash, rel.transactionHash);
});

test("booking state: an unreadable MsgExecuteEVM history is an honest failure, not None", async () => {
  const chain = await executedChain();
  chain.state.fail.executedEvmCalls = new Error("HTTP 502");
  const r = await stateOf(chain, EXEC_ID);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "rpc error");
});

test("booking state: on the EOA lane the owner's Cosmos history is not read", async () => {
  const chain = await executedChain();
  const r = await stateOf(chain, EXEC_ID, env({ LIVE_BOOK_LANE: "eoa" }));
  assertOk(r);
  assert.equal(r.state, "None");
  assert.equal(chain.callsTo("executedEvmCalls").length, 0);
});

test("booking state after a reload mid-lock: waits for the book() in flight, and lock is never sent twice", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = (await svc.checkout({ step: "quote", offerId: OFFER.id, scenario: "normal", mandate: defaultMandate() })) as CheckoutQuote & { ok: true; bookingId: Hex };
  // The chain lands the Booked event when book() is broadcast.
  const send = chain.sendCosmos.bind(chain);
  chain.sendCosmos = async (...args) => {
    const o = await send(...args);
    chain.state.logs.push(booked(q.bookingId));
    return o;
  };
  // The page sent lock, then reloaded: StrictMode runs the recovery twice, and a second tab locks too.
  const lock = svc.checkout({ step: "lock", bookingId: q.bookingId });
  const [s1, s2] = await Promise.all([svc.checkout({ step: "state", bookingId: q.bookingId }), svc.checkout({ step: "state", bookingId: q.bookingId })]);
  await svc.checkout({ step: "lock", bookingId: q.bookingId });
  await lock;
  for (const s of [s1, s2] as BookingStateResult[]) {
    assertOk(s);
    assert.equal(s.state, "Locked");
  }
  assert.equal(chain.broadcasts().length, 1, "one book() only");
});

test("POST /api/live/checkout { step: state } answers the state and rejects a malformed bookingId", async () => {
  const chain = await healthyChain();
  chain.state.logs.push(booked(ID), released(ID));
  const svc = service(chain);
  const post = (body: unknown) => handleLiveCheckout(env(), () => svc, new Request("http://x/api/live/checkout", { method: "POST", body: JSON.stringify(body) }));
  const ok = await post({ step: "state", bookingId: ID });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { state: string }).state, "Released");
  const bad = await post({ step: "state", bookingId: "0x12" });
  assert.equal(bad.status, 400);
  assert.equal(chain.broadcasts().length, 0);
});
