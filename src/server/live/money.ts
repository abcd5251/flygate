import "server-only";

/** 1 uqor (6 decimals, bank) = 1e12 wei (18 decimals, EVM). */
export const WEI_PER_UQOR = BigInt(1_000_000_000_000);

/**
 * Fee headroom per Live transaction, in uqor. An assumption until the diana probe (#17) measures
 * real fees; it only sizes balance checks and window limits, it never sets a fee.
 */
export const MAX_FEE_UQOR = BigInt(500_000);

/** US$ -> uqor at `uqorPerUsd`, rounded up to the next uqor (cent-exact, no float drift). */
export function usdToUqor(usd: number, uqorPerUsd: bigint): bigint {
  const cents = BigInt(Math.round(usd * 100));
  const scaled = cents * uqorPerUsd;
  const hundred = BigInt(100);
  return scaled / hundred + (scaled % hundred === BigInt(0) ? BigInt(0) : BigInt(1));
}

export function formatQor(uqor: bigint): string {
  const million = BigInt(1_000_000);
  const frac = (uqor % million).toString().padStart(6, "0").replace(/0+$/, "");
  return `${uqor / million}${frac ? `.${frac}` : ""} QOR`;
}
