import { test } from "node:test";
import assert from "node:assert/strict";
import { withExtraGas } from "./fee";

test("extra gas is added and the fee keeps the estimate's price per gas", () => {
  // 648,481 gas at 0.15 uqor: the book() estimate from the failed A-3 run.
  const fee = withExtraGas({ gas: "648481", amount: [{ denom: "uqor", amount: "97273" }] }, 2_000_000);
  assert.equal(fee.gas, "2648481");
  // ceil(97273 × 2648481 / 648481) = 397,276: never below the original price.
  assert.deepEqual(fee.amount, [{ denom: "uqor", amount: "397276" }]);
});

test("no extra gas leaves the fee unchanged", () => {
  const fee = { gas: "100000", amount: [{ denom: "uqor", amount: "15000" }] };
  assert.deepEqual(withExtraGas(fee, 0), fee);
});
