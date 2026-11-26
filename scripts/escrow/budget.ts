// Gas caps per tx and the EVM windows sized from them. A tx whose estimate x 1.2 exceeds its
// cap is refused before signing, so a window can never be drained past what is listed here.
import type { Hex } from "viem";
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

/** ~15 minutes: deploy, then the e2e run right after it (the expiry flow waits ~2 minutes). */
const OPEN_BLOCKS = 900;
/** Reuse an open window only with at least ~7 minutes left. */
const MIN_REMAINING_BLOCKS = 420;

type PlannedTx = { value?: bigint; gasCap: bigint };

/** A window admitting exactly these txs, opened for OPEN_BLOCKS, optionally only to `target`. */
function windowFor(txs: readonly PlannedTx[], target?: Hex): WindowSpec {
  return {
    txs: txs.length,
    value: windowValueUqor(txs, MAX_FEE_PER_GAS),
    blocks: MIN_REMAINING_BLOCKS,
    openBlocks: OPEN_BLOCKS,
    ...(target ? { target } : {}),
  };
}

const OWNER_RUN: PlannedTx[] = [{ gasCap: GAS_CAP.deploy }, { gasCap: GAS_CAP.setMandate }];
const AGENT_RUN: PlannedTx[] = [
  { value: FARE_WEI, gasCap: GAS_CAP.book },
  { value: FARE_WEI, gasCap: GAS_CAP.book },
  { value: FARE_WEI, gasCap: GAS_CAP.book },
  { gasCap: GAS_CAP.confirmTicket },
  { gasCap: GAS_CAP.cancel },
  { gasCap: GAS_CAP.refund },
];

/** Owner signer, deploy run: the CREATE and the first setMandate. Unscoped: CREATE has no recipient. */
export const ownerDeployWindow = (): WindowSpec => windowFor(OWNER_RUN);

/** Owner signer, e2e run: one setMandate on the escrow (reuses the deploy window while it lasts). */
export const ownerMandateWindow = (escrow: Hex): WindowSpec => windowFor([{ gasCap: GAS_CAP.setMandate }], escrow);

/** Agent signer, e2e run: three 1-QOR bookings, then confirmTicket, cancel and refund, escrow only. */
export const agentWindow = (escrow: Hex): WindowSpec => windowFor(AGENT_RUN, escrow);

/** uqor each sending signer must hold for one full run: its window's value (fares + max gas). */
export const SIGNER_NEED_UQOR = {
  owner: windowValueUqor(OWNER_RUN, MAX_FEE_PER_GAS),
  agent: windowValueUqor(AGENT_RUN, MAX_FEE_PER_GAS),
} as const;
