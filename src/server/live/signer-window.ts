import "server-only";
import { windowCovers, windowValueUqor, type WindowView } from "../../../scripts/escrow/plan";
import type { Hex } from "./chain";
import { WINDOW_MAX_BLOCKS } from "./mandate";

/**
 * EVM windows for the coin-60 signers (docs/FLOW.md): every address that sends an EVM tx needs
 * its own MsgOpenEVMWindow, separate from the owner account's Scoped window. The server opens
 * one before a signer's EVM tx (setMandate, confirmTicket, cancel, EOA-lane book) when the open
 * one does not cover it.
 */

/** Gas budget per signer tx; the largest measured is book() at 351,734 (docs/FLOW.md). */
export const SIGNER_GAS_CAP = BigInt(450_000);
/** Txs a newly opened signer window admits, so one window serves several steps. */
export const SIGNER_WINDOW_TXS = 6;
/** An open window is reused only with at least this many blocks left (~1 s each). */
export const SIGNER_WINDOW_MIN_BLOCKS = 60;

export interface SignerWindowOpen {
  blocks: number;
  maxTxs: number;
  /** uqor, as MsgOpenEVMWindow takes it. */
  maxValue: string;
  allowedTargets: string[];
}

/**
 * The window to open before sending `tx` at `maxFeePerGas`, or undefined when `current`
 * already covers it. A new window is scoped to `tx.to` and budgets this tx's value plus gas
 * for SIGNER_WINDOW_TXS txs.
 */
export function signerWindowToOpen(current: WindowView, tx: { to: Hex; value: bigint }, maxFeePerGas: bigint): SignerWindowOpen | undefined {
  const need = windowValueUqor([{ value: tx.value, gasCap: SIGNER_GAS_CAP }], maxFeePerGas);
  if (windowCovers(current, { txs: 1, value: need, blocks: SIGNER_WINDOW_MIN_BLOCKS, target: tx.to })) return undefined;
  const budget = [{ value: tx.value, gasCap: SIGNER_GAS_CAP }, ...Array.from({ length: SIGNER_WINDOW_TXS - 1 }, () => ({ gasCap: SIGNER_GAS_CAP }))];
  return {
    blocks: WINDOW_MAX_BLOCKS,
    maxTxs: SIGNER_WINDOW_TXS,
    maxValue: windowValueUqor(budget, maxFeePerGas).toString(),
    allowedTargets: [tx.to],
  };
}
