import "server-only";
import type { StdFee } from "@qorechain/sdk";

/**
 * `fee` with `extraGas` more gas, every coin scaled at the same price per gas (rounded up, so the
 * price never drops below the one the estimate chose).
 */
export function withExtraGas(fee: StdFee, extraGas: number): StdFee {
  const gas = BigInt(fee.gas);
  const total = gas + BigInt(extraGas);
  return {
    ...fee,
    gas: total.toString(),
    amount: fee.amount.map((c) => ({ ...c, amount: ((BigInt(c.amount) * total + gas - BigInt(1)) / gas).toString() })),
  };
}
