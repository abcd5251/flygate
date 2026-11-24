// viem clients for diana and a send helper that never blindly re-broadcasts.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkSettings } from "../bootstrap/env";
import { DIANA_EVM_CHAIN_ID } from "../../src/lib/chain";
import { afterBroadcastError } from "./plan";

/**
 * Fixed fee caps, so a window's maxValue (value + gasLimit x maxFeePerGas) can be sized up
 * front. diana's base fee measured 100 gwei, priority suggestion 12.5 gwei.
 */
export const MAX_FEE_PER_GAS = BigInt(150_000_000_000);
export const MAX_PRIORITY_FEE_PER_GAS = BigInt(12_500_000_000);
/** Gas limit = estimate x 1.2, refused when above the caller's cap. */
const GAS_LIMIT_NUM = BigInt(12);
const GAS_LIMIT_DEN = BigInt(10);

export function dianaChain(network: NetworkSettings): Chain {
  return defineChain({
    id: DIANA_EVM_CHAIN_ID,
    name: "QoreChain diana",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [network.evmRpc] } },
    blockExplorers: { default: { name: "QoreChain Explorer", url: network.explorer } },
  });
}

export interface Clients {
  chain: Chain;
  /** Reads: viem retries these on errors such as HTTP 429. */
  reads: PublicClient;
  /** Broadcasts only: no retries, so a 429 after acceptance never sends a tx twice. */
  broadcast: PublicClient;
}

export function makeClients(network: NetworkSettings): Clients {
  const chain = dianaChain(network);
  return {
    chain,
    reads: createPublicClient({
      chain,
      transport: http(network.evmRpc, { retryCount: 6, retryDelay: 1500 }),
      pollingInterval: 1500,
    }),
    broadcast: createPublicClient({ chain, transport: http(network.evmRpc, { retryCount: 0 }) }),
  };
}

export type Wallet = WalletClient<Transport, Chain, Account>;

export function walletFor(clients: Clients, privateKey: Hex): Wallet {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: clients.chain,
    transport: http(clients.chain.rpcUrls.default.http[0], { retryCount: 0 }),
  });
}

export interface TxRequest {
  label: string;
  /** Omitted for contract creation. */
  to?: Hex;
  data: Hex;
  value?: bigint;
  /** The most gas this tx may reserve; the window was sized with it. */
  gasCap: bigint;
}

/**
 * Estimate (which also surfaces a revert), sign locally, broadcast once, wait for the
 * receipt. On a broadcast error the chain is read (receipt, nonces) before deciding: a
 * landed or pending tx is waited for, an unsent one throws. Nothing is ever re-sent here.
 */
export async function sendTx(clients: Clients, wallet: Wallet, req: TxRequest): Promise<TransactionReceipt> {
  const { reads } = clients;
  const account = wallet.account;
  const value = req.value ?? BigInt(0);
  const estimate = await reads.estimateGas({ account, to: req.to, data: req.data, value });
  const gas = (estimate * GAS_LIMIT_NUM) / GAS_LIMIT_DEN;
  if (gas > req.gasCap) throw new Error(`${req.label}: needs ${gas} gas, above the ${req.gasCap} the window allows`);
  const nonce = await reads.getTransactionCount({ address: account.address, blockTag: "pending" });
  const serialized = await wallet.signTransaction({
    account,
    chain: clients.chain,
    type: "eip1559",
    to: req.to ?? null,
    data: req.data,
    value,
    gas,
    nonce,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
  });
  const hash = keccak256(serialized);
  try {
    await clients.broadcast.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    const receipt = await reads.getTransactionReceipt({ hash }).catch(() => undefined);
    const minedNonce = await reads.getTransactionCount({ address: account.address, blockTag: "latest" });
    const pendingNonce = await reads.getTransactionCount({ address: account.address, blockTag: "pending" });
    const outcome = afterBroadcastError({ txNonce: nonce, hasReceipt: receipt !== undefined, minedNonce, pendingNonce });
    const why = err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err);
    if (outcome === "not-sent") throw new Error(`${req.label} not sent: ${why}`);
    if (outcome === "nonce-taken") throw new Error(`${req.label}: nonce ${nonce} used by another tx from ${account.address}`);
    console.log(`  ${req.label}: broadcast errored (${why}) but ${hash} is ${outcome}; waiting for it`);
  }
  const receipt = await reads.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${req.label} reverted: ${hash}`);
  return receipt;
}

export interface CallRequest {
  label: string;
  address: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  gasCap: bigint;
}

export function sendContractTx(clients: Clients, wallet: Wallet, req: CallRequest): Promise<TransactionReceipt> {
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
  return sendTx(clients, wallet, { label: req.label, to: req.address, data, value: req.value, gasCap: req.gasCap });
}
