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
