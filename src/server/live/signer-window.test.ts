import { test } from "node:test";
import assert from "node:assert/strict";
import type { WindowView } from "../../../scripts/escrow/plan";
import { SIGNER_GAS_CAP, SIGNER_WINDOW_TXS, signerWindowToOpen } from "./signer-window";
import { WINDOW_MAX_BLOCKS } from "./mandate";

const ESCROW = "0x1111111111111111111111111111111111111111";
const GWEI = BigInt(1_000_000_000);
const FEE = BigInt(200) * GWEI;
const WEI_PER_UQOR = BigInt(1_000_000_000_000);
const NONE: WindowView = { live: false, remainingTxs: BigInt(0), remainingValue: BigInt(0), remainingBlocks: BigInt(0), allowedTargets: [] };

function live(patch: Partial<WindowView> = {}): WindowView {
  return { live: true, remainingTxs: BigInt(5), remainingValue: BigInt(10_000_000), remainingBlocks: BigInt(1_000), allowedTargets: [ESCROW], ...patch };
}

test("no window: opens one scoped to the target, budgeting value plus gas for several txs", () => {
  const value = BigInt(3) * BigInt(10) ** BigInt(18);
  const open = signerWindowToOpen(NONE, { to: ESCROW, value }, FEE);
  assert.ok(open);
  assert.equal(open.blocks, WINDOW_MAX_BLOCKS);
  assert.equal(open.maxTxs, SIGNER_WINDOW_TXS);
  assert.deepEqual(open.allowedTargets, [ESCROW]);
  const expected = (value + BigInt(SIGNER_WINDOW_TXS) * SIGNER_GAS_CAP * FEE) / WEI_PER_UQOR;
  assert.equal(open.maxValue, expected.toString());
});

test("a live window that covers the tx is reused", () => {
  assert.equal(signerWindowToOpen(live(), { to: ESCROW, value: BigInt(0) }, FEE), undefined);
});

test("a window that is used up, short on value, near its end or scoped elsewhere is replaced", () => {
  const tx = { to: ESCROW as `0x${string}`, value: BigInt(0) };
  assert.ok(signerWindowToOpen(live({ remainingTxs: BigInt(0) }), tx, FEE));
  assert.ok(signerWindowToOpen(live({ remainingValue: BigInt(1) }), tx, FEE));
  assert.ok(signerWindowToOpen(live({ remainingBlocks: BigInt(10) }), tx, FEE));
  assert.ok(signerWindowToOpen(live({ allowedTargets: ["0x2222222222222222222222222222222222222222"] }), tx, FEE));
});
