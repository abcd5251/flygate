import { test } from "node:test";
import assert from "node:assert/strict";
import { afterBroadcastError, topUpAmount, windowCovers, windowValueUqor, type WindowView } from "./plan";

const QOR = BigInt(1_000_000);

test("an unfunded signer is topped up to the target", () => {
  assert.equal(topUpAmount(BigInt(0), { min: BigInt(4) * QOR, target: BigInt(5) * QOR }), BigInt(5) * QOR);
});

test("a signer already holding the minimum is skipped", () => {
  assert.equal(topUpAmount(BigInt(4) * QOR, { min: BigInt(4) * QOR, target: BigInt(5) * QOR }), BigInt(0));
});

test("a signer below the minimum gets only the difference to the target", () => {
  assert.equal(topUpAmount(BigInt(1_500_000), { min: BigInt(4) * QOR, target: BigInt(5) * QOR }), BigInt(3_500_000));
});

// After eth_sendRawTransaction errors, the tx may still have landed. We know its hash and
// nonce, so read the chain instead of resending.

test("a broadcast error whose tx has a receipt counts as landed", () => {
  assert.equal(afterBroadcastError({ txNonce: 7, hasReceipt: true, minedNonce: 8, pendingNonce: 8 }), "landed");
});

test("a broadcast error with the nonce unused means nothing was sent", () => {
  assert.equal(afterBroadcastError({ txNonce: 7, hasReceipt: false, minedNonce: 7, pendingNonce: 7 }), "not-sent");
});

test("a broadcast error with the tx waiting in the mempool means wait for it", () => {
  assert.equal(afterBroadcastError({ txNonce: 7, hasReceipt: false, minedNonce: 7, pendingNonce: 8 }), "pending");
});

test("a mined nonce without our receipt means another tx took the nonce", () => {
  assert.equal(afterBroadcastError({ txNonce: 7, hasReceipt: false, minedNonce: 8, pendingNonce: 8 }), "nonce-taken");
});

// An open EVM window is reused only when it still covers the whole run.
const ESCROW = "0x899153F0F66Dad06B5AE948DC63E2dC1f1806D63";
const live: WindowView = {
  live: true,
  remainingTxs: BigInt(6),
  remainingValue: BigInt(3_600_000),
  remainingBlocks: BigInt(1500),
  allowedTargets: [ESCROW.toLowerCase()],
};
const need = { txs: 6, value: BigInt(3_500_000), blocks: 900, target: ESCROW };

test("a live window with enough txs, value, blocks and the escrow as target is reused", () => {
  assert.equal(windowCovers(live, need), true);
});

test("no window, or one short of txs, value or blocks, needs a new one", () => {
  assert.equal(windowCovers({ ...live, live: false }, need), false);
  assert.equal(windowCovers({ ...live, remainingTxs: BigInt(5) }, need), false);
  assert.equal(windowCovers({ ...live, remainingValue: BigInt(3_499_999) }, need), false);
  assert.equal(windowCovers({ ...live, remainingBlocks: BigInt(899) }, need), false);
});

test("a window narrowed to other targets does not cover the escrow", () => {
  assert.equal(windowCovers({ ...live, allowedTargets: ["0x0000000000000000000000000000000000000001"] }, need), false);
});

test("window value is value plus gasCap x maxFee per tx, in uqor rounded up", () => {
  const maxFee = BigInt(150_000_000_000); // 150 gwei
  // 1 QOR fare + 600k gas x 150 gwei (0.09 QOR) = 1,090,000 uqor; refund 1 gas -> 1 uqor (rounded up).
  assert.equal(
    windowValueUqor([{ value: BigInt(10) ** BigInt(18), gasCap: BigInt(600_000) }, { gasCap: BigInt(1) }], maxFee),
    BigInt(1_090_001),
  );
});
