// Eth-native Cosmos txs from a coin-60 signer (register its ML-DSA-87 key, open a window), sent
// once over REST. Same approach as `pnpm live:probe` (probe.ts keeps its own copy for now).
// The broadcast is never retried; only the account lookup and the inclusion wait are reads.
import {
  buildRegisterPqcKeyMsg,
  EthNativeSigner,
  openEvmWindowMsg,
  signProofOfPossession,
  waitForTx,
  type EthBroadcaster,
  type QoreChainClient,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { retrying } from "../bootstrap/chain";
import { feeUqor } from "./probe-lib";

export interface EthNativeCtx {
  client: QoreChainClient;
  rest: string;
  chainId: string;
}

const GAS_PRICE_UQOR = "0.15";
/** Registration carries a 2592-byte key + 4627-byte proof. */
export const REGISTER_GAS = 1_000_000;
export const WINDOW_GAS = 500_000;

async function accountSequence(ctx: EthNativeCtx, address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  type Acc = { account_number?: string; sequence?: string; base_account?: Acc };
  const body = await retrying(() => ctx.client.rest.get<{ account?: Acc }>(`/cosmos/auth/v1beta1/accounts/${address}`));
  const acc = body.account?.base_account ?? body.account;
  if (!acc?.account_number) throw new Error(`No account record for ${address} (fund it first)`);
  return { accountNumber: BigInt(acc.account_number), sequence: BigInt(acc.sequence ?? "0") };
}

function restBroadcaster(ctx: EthNativeCtx): EthBroadcaster {
  return {
    async broadcastTx(tx: Uint8Array) {
      const res = await fetch(`${ctx.rest}/cosmos/tx/v1beta1/txs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_bytes: Buffer.from(tx).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
      });
      if (!res.ok) throw new Error(`broadcast: HTTP ${res.status} (not resent)`);
      const body = (await res.json()) as { tx_response?: { code: number; txhash: string; raw_log?: string; codespace?: string } };
      const t = body.tx_response;
      if (!t) throw new Error("broadcast: no tx_response (not resent)");
      if (t.code !== 0) return { code: t.code, transactionHash: t.txhash, rawLog: `${t.codespace ?? ""} ${t.raw_log ?? ""}`.trim() };
      const included = await retrying(() => waitForTx(ctx.client.rest, t.txhash, { timeoutMs: 60_000, pollIntervalMs: 1_500 }));
      return { code: included.code, transactionHash: included.txHash, height: included.height, rawLog: included.rawLog };
    },
  };
}

/** One eth-native Cosmos tx. Broadcast once; throws on a non-zero code. Returns the Cosmos hash. */
export async function sendEthNative(
  ctx: EthNativeCtx,
  who: UnifiedAccount,
  mode: "classical" | "hybrid",
  messages: ReturnType<typeof openEvmWindowMsg>[],
  gas: number,
): Promise<string> {
  const signer = new EthNativeSigner(who, { signMode: mode, signBytesVersion: "auto", rest: ctx.rest });
  const seq = await accountSequence(ctx, who.cosmos);
  const res = await signer.signAndBroadcast(restBroadcaster(ctx), {
    chainId: ctx.chainId,
    messages,
    fee: { amount: [{ denom: "uqor", amount: feeUqor(gas, GAS_PRICE_UQOR).toString() }], gas: String(gas) },
    ...seq,
  });
  if (res.code !== 0) throw new Error(`code ${res.code} ${res.transactionHash}: ${res.rawLog ?? ""}`);
  return res.transactionHash;
}

/** Register the signer's ML-DSA-87 key (`deriveUnifiedAccount(mnemonic).pqc`). Classical-signed. */
export function registerSignerPqc(ctx: EthNativeCtx, who: UnifiedAccount): Promise<string> {
  const proof = signProofOfPossession({ chainId: ctx.chainId, account: who.cosmos, keypair: who.pqc, algorithmId: 1 });
  const msg = buildRegisterPqcKeyMsg(who.cosmos, { pqcKeypair: who.pqc, proofOfPossession: proof });
  return sendEthNative(ctx, who, "classical", [msg], REGISTER_GAS);
}

/** Open a window on the signer, scoped to `targets`. Hybrid-signed. */
export function openSignerWindow(
  ctx: EthNativeCtx,
  who: UnifiedAccount,
  window: { blocks: number; maxTxs: number; maxValue: string; allowedTargets: string[] },
): Promise<string> {
  const msg = openEvmWindowMsg({ sender: who.cosmos, ...window });
  return sendEthNative(ctx, who, "hybrid", [msg], WINDOW_GAS);
}
