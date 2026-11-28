import { test } from "node:test";
import assert from "node:assert/strict";
import { executedEvmCallsOf, type TxResponse } from "./executed-calls";

const OWNER = "qor1rg4wqdyez5c22aw0qkcrvtn7zhmhnpwq5qp835";
const ESCROW = "0xAEF0d6a8B85A9a95091818c3142B8b065C7fCE10";
const EXECUTE = "/qorechain.abstractaccount.v1.MsgExecuteEVM";
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

// Shaped like /cosmos/tx/v1beta1/txs on diana (tx BECF62A7… and 956D47E9…).
function txResponse(o: { hash: string; height: string; code?: number; messages: object[]; failedIndexes?: string[] }): TxResponse {
  return {
    txhash: o.hash,
    height: o.height,
    code: o.code ?? 0,
    tx: { body: { messages: o.messages } },
    events: (o.failedIndexes ?? []).map((i) => ({
      type: "abstractaccount_execution_failed",
      attributes: [{ key: "account", value: OWNER }, { key: "reason", value: "execution reverted" }, { key: "msg_index", value: i }],
    })),
  };
}
const execute = (data: string, account = OWNER) => ({ "@type": EXECUTE, account, to: ESCROW, value: "1", data: b64(data) });

test("a MsgExecuteEVM that ran as the account is kept, with its hash, height, target and calldata", () => {
  const calls = executedEvmCallsOf([txResponse({ hash: "BECF", height: "10782379", messages: [execute("2f876d8c01")] })], OWNER);
  assert.deepEqual(calls, [{ hash: "BECF", height: BigInt(10782379), to: ESCROW, data: "0x2f876d8c01" }]);
});

test("failed executions, failed txs, other accounts and other messages are left out", () => {
  const calls = executedEvmCallsOf(
    [
      txResponse({ hash: "FAIL", height: "2", messages: [execute("aa")], failedIndexes: ["0"] }),
      txResponse({ hash: "CODE", height: "3", code: 10, messages: [execute("bb")] }),
      txResponse({ hash: "OTHER", height: "4", messages: [execute("cc", "qor1someoneelse")] }),
      txResponse({ hash: "SEND", height: "5", messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }] }),
      txResponse({ hash: "MIXED", height: "6", messages: [execute("dd"), execute("ee")], failedIndexes: ["1"] }),
    ],
    OWNER,
  );
  assert.deepEqual(calls.map((c) => [c.hash, c.data]), [["MIXED", "0xdd"]]);
});
