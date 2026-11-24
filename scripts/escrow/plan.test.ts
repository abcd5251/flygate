import { test } from "node:test";
import assert from "node:assert/strict";
import { afterBroadcastError, topUpAmount } from "./plan";

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
