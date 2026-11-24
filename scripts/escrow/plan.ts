// Pure decisions for the escrow deploy/e2e scripts. Nothing here touches the network.

export interface TopUpRule {
  /** Skip the transfer when the balance is at least this. */
  min: bigint;
  /** Otherwise bring the balance up to this. */
  target: bigint;
}

/** Amount to send so a rerun never funds twice: 0 when `balance` already meets `rule.min`. */
export function topUpAmount(balance: bigint, rule: TopUpRule): bigint {
  return balance >= rule.min ? BigInt(0) : rule.target - balance;
}

export interface BroadcastCheck {
  txNonce: number;
  /** A receipt exists for the signed tx's hash. */
  hasReceipt: boolean;
  /** Sender's nonce at "latest" (mined txs). */
  minedNonce: number;
  /** Sender's nonce at "pending" (mined plus mempool). */
  pendingNonce: number;
}

export type BroadcastOutcome = "landed" | "pending" | "not-sent" | "nonce-taken";

/**
 * What a failed eth_sendRawTransaction really did, read from the chain. Only "not-sent"
 * means the same signed tx may be sent again; "nonce-taken" needs a human.
 */
export function afterBroadcastError(c: BroadcastCheck): BroadcastOutcome {
  if (c.hasReceipt) return "landed";
  if (c.minedNonce > c.txNonce) return "nonce-taken";
  if (c.pendingNonce > c.txNonce) return "pending";
  return "not-sent";
}

/** The parts of an EVM authorisation window (`fetchEvmWindow`) the scripts decide on. */
export interface WindowView {
  live: boolean;
  remainingTxs: bigint;
  /** uqor: value plus max fee of every admitted tx. */
  remainingValue: bigint;
  remainingBlocks: bigint;
  /** Empty means any recipient. */
  allowedTargets: readonly string[];
}

export interface WindowNeed {
  txs: number;
  value: bigint;
  blocks: number;
  /** The recipient every tx goes to, when the window must admit it. */
  target?: string;
}

/** Whether an already-open window covers a run, so no new MsgOpenEVMWindow is needed. */
export function windowCovers(w: WindowView, need: WindowNeed): boolean {
  if (!w.live) return false;
  if (w.remainingTxs < BigInt(need.txs) || w.remainingValue < need.value) return false;
  if (w.remainingBlocks < BigInt(need.blocks)) return false;
  if (need.target && w.allowedTargets.length > 0) {
    return w.allowedTargets.some((t) => t.toLowerCase() === need.target!.toLowerCase());
  }
  return true;
}

const WEI_PER_UQOR = BigInt(1_000_000_000_000);

/** What a window must allow for these txs: sum of value + gasCap x maxFeePerGas, wei -> uqor rounded up. */
export function windowValueUqor(txs: readonly { value?: bigint; gasCap: bigint }[], maxFeePerGas: bigint): bigint {
  const wei = txs.reduce((sum, t) => sum + (t.value ?? BigInt(0)) + t.gasCap * maxFeePerGas, BigInt(0));
  return (wei + WEI_PER_UQOR - BigInt(1)) / WEI_PER_UQOR;
}
