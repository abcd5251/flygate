// Gas caps per tx and the EVM windows sized from them. A tx whose estimate x 1.2 exceeds its
// cap is refused before signing, so a window can never be drained past what is listed here.
import type { Hex } from "../evm/keys";
import { windowValueUqor } from "./plan";
import type { WindowSpec } from "./native";
import { MAX_FEE_PER_GAS } from "./tx";

export const GAS_CAP = {
  deploy: BigInt(2_200_000),
  setMandate: BigInt(300_000),
  book: BigInt(600_000),
  confirmTicket: BigInt(500_000),
  cancel: BigInt(500_000),
  refund: BigInt(150_000),
} as const;

/** Test fare per booking: 1 QOR. */
export const FARE_WEI = BigInt(10) ** BigInt(18);

/** ~30 minutes: long enough for the e2e run (the expiry flow waits ~2 minutes). */
const OPEN_BLOCKS = 1800;
/** Reuse an open window only with at least ~10 minutes left. */
const MIN_REMAINING_BLOCKS = 600;

/** Owner signer, deploy run: the CREATE and the first setMandate. Unscoped: CREATE has no recipient. */
export function ownerDeployWindow(): WindowSpec {
  const txs = [{ gasCap: GAS_CAP.deploy }, { gasCap: GAS_CAP.setMandate }];
  const value = windowValueUqor(txs, MAX_FEE_PER_GAS);
  return { txs: txs.length, value, blocks: MIN_REMAINING_BLOCKS, maxTxs: txs.length, maxValue: value, openBlocks: OPEN_BLOCKS };
}

/** Owner signer, e2e run: one setMandate on the escrow. */
export function ownerMandateWindow(escrow: Hex): WindowSpec {
  const txs = [{ gasCap: GAS_CAP.setMandate }];
  const value = windowValueUqor(txs, MAX_FEE_PER_GAS);
  return { txs: 1, value, blocks: MIN_REMAINING_BLOCKS, maxTxs: 1, maxValue: value, openBlocks: OPEN_BLOCKS, target: escrow };
}

/** Agent signer, e2e run: three 1-QOR bookings, then confirmTicket, cancel and refund, escrow only. */
export function agentWindow(escrow: Hex): WindowSpec {
  const txs = [
    { value: FARE_WEI, gasCap: GAS_CAP.book },
    { value: FARE_WEI, gasCap: GAS_CAP.book },
    { value: FARE_WEI, gasCap: GAS_CAP.book },
    { gasCap: GAS_CAP.confirmTicket },
    { gasCap: GAS_CAP.cancel },
    { gasCap: GAS_CAP.refund },
  ];
  const value = windowValueUqor(txs, MAX_FEE_PER_GAS);
  return { txs: txs.length, value, blocks: MIN_REMAINING_BLOCKS, maxTxs: txs.length, maxValue: value, openBlocks: OPEN_BLOCKS, target: escrow };
}
