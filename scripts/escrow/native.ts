// Native-lane (Cosmos) txs from an eth-native EVM signer (coin-60 key, qor1 form of its
// 20 bytes): PQC key registration and EVM authorisation windows.
//
// Measured on diana (2026-11-24): an EVM tx is admitted only from an account that has a
// registered ML-DSA-87 key AND a live window opened by a hybrid-signed MsgOpenEVMWindow.
// The window's maxValue counts value plus gasLimit x maxFeePerGas of every admitted tx.
import { createHash } from "node:crypto";
import {
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  EthNativeSigner,
  fetchEvmWindow,
  openEvmWindowMsg,
  resolveSignBytesVersion,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { DENOM, retrying } from "../bootstrap/chain";
import type { NetworkSettings } from "../bootstrap/env";
import { pqcKeyStatusOnEvm } from "../evm/chain";
import { ALGORITHM_ML_DSA_87 } from "../evm/pqcKeyStatus";
import type { EvmRole } from "../evm/keys";
import { windowCovers, type WindowNeed } from "./plan";

type EncodeObject = ReturnType<typeof buildRegisterPqcKeyMsg>;

/** Gas price for native-lane txs (DEFAULT_GAS_PRICE; the chain floor is 0.1 uqor). */
const GAS_PRICE_UQOR = 0.15;
const SIMULATE_GAS = 3_000_000;
const GAS_HEADROOM = 1.4;

export interface NativeTx {
  hash: string;
  block: number;
}

/** The role's EVM signer as a unified eth-native account (its PQC key is derivePqcCanonical). */
export async function unifiedSigner(role: EvmRole, mnemonic: string): Promise<UnifiedAccount> {
  const unified = await deriveUnifiedAccount(mnemonic);
  if (unified.evm.toLowerCase() !== role.signer.address.toLowerCase()) {
    throw new Error(`${role.role}: unified account ${unified.evm} is not the EVM signer ${role.signer.address}`);
  }
  return unified;
}

async function restGet<T>(network: NetworkSettings, path: string): Promise<T> {
  return retrying(async () => {
    const res = await fetch(`${network.rest}${path}`);
    if (!res.ok) throw new Error(`REST ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  });
}

async function restPost<T>(network: NetworkSettings, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${network.rest}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function accountSequence(network: NetworkSettings, address: string) {
  const { account } = await restGet<{ account: { account_number: string; sequence: string } }>(
    network,
    `/cosmos/auth/v1beta1/accounts/${address}`,
  );
  return { accountNumber: BigInt(account.account_number), sequence: BigInt(account.sequence) };
}

interface TxLookup {
  tx_response?: { code: number; height: string; raw_log: string; gas_used: string };
}

/**
 * One lookup of a broadcast tx by hash; undefined until it is in a block. Deliberately not
 * wrapped in `retrying`, and the broadcast itself is never retried: sendNative polls this
 * instead of resending, so a lost broadcast answer can never send a tx twice.
 */
async function findTx(network: NetworkSettings, hash: string): Promise<TxLookup["tx_response"] | undefined> {
  const res = await fetch(`${network.rest}/cosmos/tx/v1beta1/txs/${hash}`);
  if (!res.ok) return undefined;
  return ((await res.json()) as TxLookup).tx_response;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign (simulate first for gas), broadcast once, wait for inclusion. The tx hash is
 * known before broadcasting, so a broadcast error is followed by a lookup, never a resend.
 */
async function sendNative(
  network: NetworkSettings,
  unified: UnifiedAccount,
  messages: EncodeObject[],
  mode: "hybrid" | "classical",
  label: string,
): Promise<NativeTx> {
  const signer = new EthNativeSigner(unified, { signMode: mode });
  const signBytesVersion = await retrying(() => resolveSignBytesVersion({ chainId: network.chainId, rest: network.rest }));
  const seq = await accountSequence(network, unified.cosmos);
  const sign = (gas: number) =>
    signer.sign({
      chainId: network.chainId,
      ...seq,
      messages,
      fee: { amount: [{ denom: DENOM, amount: Math.ceil(gas * GAS_PRICE_UQOR).toString() }], gas: gas.toString() },
      signBytesVersion,
    });

  const sim = await retrying(async () => {
    const r = await restPost<{ gas_info?: { gas_used: string }; message?: string }>(network, "/cosmos/tx/v1beta1/simulate", {
      tx_bytes: Buffer.from(sign(SIMULATE_GAS).txRawBytes).toString("base64"),
    });
    if (r.status === 429) throw new Error("429 rate limited");
    if (!r.body.gas_info) throw new Error(`${label}: simulation failed: ${r.body.message ?? r.status}`);
    return Number(r.body.gas_info.gas_used);
  });
  const signed = sign(Math.ceil(sim * GAS_HEADROOM));
  const hash = createHash("sha256").update(signed.txRawBytes).digest("hex").toUpperCase();

  const sent = await restPost<{ tx_response?: { code: number; raw_log: string }; message?: string }>(
    network,
    "/cosmos/tx/v1beta1/txs",
    { tx_bytes: Buffer.from(signed.txRawBytes).toString("base64"), mode: "BROADCAST_MODE_SYNC" },
  ).catch((err: unknown) => ({ status: 0, body: { message: String(err) } as { tx_response?: { code: number; raw_log: string }; message?: string } }));
  const checkTx = sent.body.tx_response;
  if (checkTx && checkTx.code !== 0) throw new Error(`${label} refused (code ${checkTx.code}): ${checkTx.raw_log}`);
  if (!checkTx) console.log(`  ${label}: broadcast answered ${sent.status} ${sent.body.message ?? ""}; looking up ${hash}`);

  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const tx = await findTx(network, hash).catch(() => undefined);
    if (tx) {
      if (tx.code !== 0) throw new Error(`${label} failed in block ${tx.height} (code ${tx.code}): ${tx.raw_log}`);
      return { hash, block: Number(tx.height) };
    }
  }
  throw new Error(`${label}: ${hash} not found after 90s. Rerun; the state check skips it if it landed.`);
}

/**
 * Register the signer's ML-DSA-87 key with proof of possession, unless pqcKeyStatus already
 * shows that key, proven. Classical-signed: MsgRegisterPQCKeyV2 is the bootstrap-exempt tx.
 */
export async function ensureSignerPqc(
  network: NetworkSettings,
  role: EvmRole,
  unified: UnifiedAccount,
): Promise<NativeTx | undefined> {
  const status = await pqcKeyStatusOnEvm(network.evmRpc, role.signer.address);
  const ours = Buffer.from(unified.pqc.publicKey);
  if (status.registered) {
    if (!ours.equals(Buffer.from(status.pubkey))) throw new Error(`${role.role} signer holds a different PQC key on chain`);
    if (!status.possessionProven) throw new Error(`${role.role} signer key registered without proof of possession`);
    return undefined;
  }
  const proofOfPossession = signProofOfPossession({
    chainId: network.chainId,
    account: unified.cosmos,
    algorithmId: ALGORITHM_ML_DSA_87,
    keypair: unified.pqc,
  });
  const msg = buildRegisterPqcKeyMsg(unified.cosmos, { pqcKeypair: unified.pqc, keyType: "hybrid", proofOfPossession });
  const tx = await sendNative(network, unified, [msg], "classical", `${role.role} signer PQC registration`);
  const after = await pqcKeyStatusOnEvm(network.evmRpc, role.signer.address);
  if (!after.registered || !after.possessionProven || !ours.equals(Buffer.from(after.pubkey))) {
    throw new Error(`${role.role} signer registration landed (${tx.hash}) but pqcKeyStatus disagrees`);
  }
  return tx;
}

/**
 * A run's window need. A newly opened window gets exactly `txs` as maxTxs, `value` as
 * maxValue and `target` as its only allowed target; `blocks` is the minimum lifetime left
 * for reusing an open one.
 */
export interface WindowSpec extends WindowNeed {
  /** Lifetime in blocks of a newly opened window (~1.03 s each on diana). */
  openBlocks: number;
}

/** Open a hybrid-signed EVM window unless a live one already covers `spec`. */
export async function ensureWindow(
  network: NetworkSettings,
  role: EvmRole,
  unified: UnifiedAccount,
  spec: WindowSpec,
): Promise<NativeTx | undefined> {
  const current = await retrying(() => fetchEvmWindow({ rest: network.rest, address: unified.cosmos }));
  if (windowCovers(current, spec)) return undefined;
  const msg = openEvmWindowMsg({
    sender: unified.cosmos,
    blocks: spec.openBlocks,
    maxTxs: spec.txs,
    maxValue: spec.value.toString(),
    ...(spec.target ? { allowedTargets: [spec.target] } : {}),
  });
  const tx = await sendNative(network, unified, [msg], "hybrid", `${role.role} signer EVM window`);
  const after = await retrying(() => fetchEvmWindow({ rest: network.rest, address: unified.cosmos }));
  if (!windowCovers(after, spec)) throw new Error(`${role.role} window opened (${tx.hash}) but does not cover the run`);
  return tx;
}
