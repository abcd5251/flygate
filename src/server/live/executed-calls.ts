import "server-only";
import type { ExecutedEvmCall, Hex } from "./chain";

const EXECUTE_EVM = "/qorechain.abstractaccount.v1.MsgExecuteEVM";

/** The parts of a /cosmos/tx/v1beta1/txs `tx_responses` entry read here. */
export interface TxResponse {
  txhash: string;
  height: string;
  code: number;
  tx: { body: { messages: Array<{ "@type"?: string; account?: string; to?: string; data?: string }> } };
  events?: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
}

/**
 * The MsgExecuteEVM calls in `txs` that ran as `account` and did not fail. The tx's code is 0
 * even when the EVM call reverted; the chain then emits `abstractaccount_execution_failed` for
 * that message index instead (D-09).
 */
export function executedEvmCallsOf(txs: TxResponse[], account: string): ExecutedEvmCall[] {
  const out: ExecutedEvmCall[] = [];
  for (const t of txs) {
    if (t.code !== 0) continue;
    const failed = new Set(
      (t.events ?? [])
        .filter((e) => e.type === "abstractaccount_execution_failed")
        .map((e) => e.attributes.find((a) => a.key === "msg_index")?.value),
    );
    t.tx.body.messages.forEach((m, i) => {
      if (m["@type"] !== EXECUTE_EVM || m.account !== account || failed.has(String(i)) || !m.to) return;
      out.push({ hash: t.txhash, height: BigInt(t.height), to: m.to as Hex, data: `0x${Buffer.from(m.data ?? "", "base64").toString("hex")}` });
    });
  }
  return out;
}
