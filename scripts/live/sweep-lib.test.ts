import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import type { Hex } from "./probe-lib";
import { FakeSweepChain } from "./sweep-fake";
import {
  classifyBookings,
  decodeEscrowLog,
  ESCROW_EVENTS_ABI,
  formatRemaining,
  readSweepEnv,
  runSweep,
  type EscrowEvent,
  type SweepOptions,
} from "./sweep-lib";

// Public Foundry/Hardhat test mnemonic: not a secret, safe in a test.
const M = "test test test test test test test test test test test junk";
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ESCROW: Hex = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const OWNER: Hex = "0x1111111111111111111111111111111111111111";
const AGENT: Hex = "0x2222222222222222222222222222222222222222";
const MERCHANT: Hex = "0x3333333333333333333333333333333333333333";
const NOW = BigInt(1_800_000_000);
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const PRICE = BigInt(10) ** BigInt(16); // 0.01 QOR

const booked = (n: number, deadline: bigint): EscrowEvent => ({
  kind: "Booked",
  bookingId: id(n),
  agent: AGENT,
  merchant: MERCHANT,
  priceWei: PRICE,
  deadline,
});

/** bookings 1..5: 1 expired, 2 released (expired), 3 refunded (expired), 4 still in window, 5 expired. */
function scenario(): FakeSweepChain {
  return new FakeSweepChain({
    code: { [ESCROW]: "0x6080" },
    head: { number: BigInt(12_345), timestamp: NOW },
    events: [
      { block: BigInt(101), event: { kind: "MandateSet", owner: OWNER, agent: AGENT } },
      { block: BigInt(200), event: booked(1, NOW - BigInt(60)) },
      { block: BigInt(300), event: booked(2, NOW - BigInt(600)) },
      { block: BigInt(301), event: { kind: "Released", bookingId: id(2) } },
      { block: BigInt(6_000), event: booked(3, NOW - BigInt(600)) },
      { block: BigInt(6_100), event: { kind: "Refunded", bookingId: id(3) } },
      { block: BigInt(12_000), event: booked(4, NOW + BigInt(125)) },
      { block: BigInt(12_300), event: booked(5, NOW - BigInt(1)) },
    ],
  });
}

function opts(lines: string[], extra: Partial<SweepOptions> = {}): SweepOptions {
  return { escrow: ESCROW, deployBlock: BigInt(100), explorer: "https://explore.example", secrets: [M, PK], print: (l) => lines.push(l), ...extra };
}

test("refunds only bookings that are Locked and past their deadline", async () => {
  const chain = scenario();
  const lines: string[] = [];
  const res = await runSweep(chain, opts(lines));
  assert.deepEqual(chain.refundsSent(), [id(1), id(5)]);
  assert.deepEqual(res.refunded.map((r) => r.bookingId), [id(1), id(5)]);
  assert.deepEqual(res.pending.map((b) => b.bookingId), [id(4)]);
  assert.equal(res.settled, 2);
  const out = lines.join("\n");
  // bookingId, tx hash and explorer link for each refund; owner is the mandate's recorded owner.
  assert.match(out, new RegExp(`ok +${id(1)}.*owner ${OWNER}`));
  assert.ok(out.includes(`https://explore.example/tx/${res.refunded[0].hash}`));
  // the pending one is listed with its remaining time (refundable at deadline + 1 s).
  assert.match(out, new RegExp(`wait +${id(4)}.*refundable in 2m 06s`));
});

test("scans from the deploy block to the head in bounded chunks", async () => {
  const chain = scenario();
  await runSweep(chain, opts([], { logSpan: BigInt(5_000) }));
  const ranges = chain.calls.flatMap((c) => (c.method === "escrowEvents" ? [[c.from, c.to]] : []));
  assert.deepEqual(ranges, [
    [BigInt(100), BigInt(5_099)],
    [BigInt(5_100), BigInt(10_099)],
    [BigInt(10_100), BigInt(12_345)],
  ]);
});

test("a failed refund is reported with its code, never resent, and the sweep goes on", async () => {
  const chain = scenario();
  chain.state.refund[id(1)] = { kind: "refused", code: "no-window", error: "evm window required" };
  const lines: string[] = [];
  const res = await runSweep(chain, opts(lines));
  assert.deepEqual(chain.refundsSent(), [id(1), id(5)]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.refunded[0].bookingId, id(5));
  assert.match(lines.join("\n"), new RegExp(`FAIL +${id(1)} +refused \\(no-window\\)`));
});

test("a revert shows the tx and its code; a thrown send counts as unknown and is not resent", async () => {
  const chain = scenario();
  chain.state.refund[id(1)] = { kind: "reverted", hash: id(99), code: "reverted" };
  chain.state.refund[id(5)] = new Error("socket hang up");
  const lines: string[] = [];
  const res = await runSweep(chain, opts(lines));
  assert.deepEqual(chain.refundsSent(), [id(1), id(5)]);
  assert.deepEqual(res.failed.map((f) => f.outcome.kind), ["reverted", "error"]);
  const out = lines.join("\n");
  assert.ok(out.includes(`https://explore.example/tx/${id(99)}`));
  assert.match(out, /not resent.*socket hang up/);
});

test("--dry-run lists what would be refunded and sends nothing", async () => {
  const chain = scenario();
  const lines: string[] = [];
  await runSweep(chain, opts(lines, { dryRun: true }));
  assert.deepEqual(chain.refundsSent(), []);
  assert.match(lines.join("\n"), /would refund/);
});

test("nothing is sent on the wrong chain, without contract code, or with a deploy block past the head", async () => {
  for (const [patch, msg] of [
    [{ chainId: 1 }, /chain id is 1/],
    [{ code: {} }, /No contract at FLIGHT_ESCROW_ADDRESS/],
    [{ head: { number: BigInt(50), timestamp: NOW } }, /after the latest block/],
  ] as const) {
    const chain = scenario();
    Object.assign(chain.state, patch);
    await assert.rejects(runSweep(chain, opts([])), msg);
    assert.deepEqual(chain.refundsSent(), []);
  }
});

test("output never carries key material", async () => {
  const chain = scenario();
  chain.state.refund[id(1)] = new Error(`signer ${PK} failed`);
  await assert.rejects(runSweep(chain, opts([])), /key material/);
});

test("readSweepEnv fails, naming the variable, when the escrow address or deploy block is missing", () => {
  const ok = { FLIGHT_ESCROW_ADDRESS: ESCROW, FLIGHT_ESCROW_DEPLOY_BLOCK: "100", OWNER_MNEMONIC: M };
  assert.throws(() => readSweepEnv({ ...ok, FLIGHT_ESCROW_ADDRESS: undefined }), /FLIGHT_ESCROW_ADDRESS is not set/);
  assert.throws(() => readSweepEnv({ ...ok, FLIGHT_ESCROW_ADDRESS: "0x12" }), /FLIGHT_ESCROW_ADDRESS is not a valid 0x address/);
  assert.throws(() => readSweepEnv({ ...ok, FLIGHT_ESCROW_DEPLOY_BLOCK: undefined }), /FLIGHT_ESCROW_DEPLOY_BLOCK is not set/);
  assert.throws(() => readSweepEnv({ ...ok, FLIGHT_ESCROW_DEPLOY_BLOCK: "latest" }), /FLIGHT_ESCROW_DEPLOY_BLOCK is not a block number/);
  assert.throws(() => readSweepEnv({ ...ok, OWNER_MNEMONIC: undefined }), (err: Error) => /OWNER_MNEMONIC/.test(err.message) && !err.message.includes("test test"));
  const env = readSweepEnv({}, `FLIGHT_ESCROW_ADDRESS=${ESCROW}\nFLIGHT_ESCROW_DEPLOY_BLOCK="42"\nOWNER_MNEMONIC="${M}"\n`);
  assert.equal(env.deployBlock, BigInt(42));
  assert.equal(env.escrow, ESCROW);
});

test("classifyBookings: deadline itself is not expired (contract reverts at block.timestamp == deadline)", () => {
  const c = classifyBookings([booked(1, NOW)], NOW);
  assert.equal(c.expired.length, 0);
  assert.equal(c.pending.length, 1);
});

test("decodeEscrowLog reads FlightEscrow's Booked / Released / Refunded logs and skips others", () => {
  const bookedLog = {
    topics: encodeEventTopics({ abi: ESCROW_EVENTS_ABI, eventName: "Booked", args: { bookingId: id(7), agent: AGENT, merchant: MERCHANT } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }], [PRICE, NOW]),
  };
  assert.deepEqual(decodeEscrowLog(bookedLog as never), {
    kind: "Booked",
    bookingId: id(7),
    agent: AGENT,
    merchant: MERCHANT,
    priceWei: PRICE,
    deadline: NOW,
  });
  const refundedLog = {
    topics: encodeEventTopics({ abi: ESCROW_EVENTS_ABI, eventName: "Refunded", args: { bookingId: id(7) } }),
    data: encodeAbiParameters([{ type: "uint8" }], [1]),
  };
  assert.deepEqual(decodeEscrowLog(refundedLog as never), { kind: "Refunded", bookingId: id(7) });
  assert.equal(decodeEscrowLog({ topics: [id(1)], data: "0x" } as never), undefined);
});

test("formatRemaining", () => {
  assert.equal(formatRemaining(BigInt(42)), "42s");
  assert.equal(formatRemaining(BigInt(190)), "3m 10s");
  assert.equal(formatRemaining(BigInt(3725)), "1h 02m 05s");
});
