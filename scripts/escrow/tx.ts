// viem clients for diana and a send helper that never blindly re-broadcasts.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  encodeFunctionData,
  type Abi,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  type Account,
  type Chain,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { NetworkSettings } from "../bootstrap/env";
import { DIANA_EVM_CHAIN_ID } from "../evm/chain";
import type { Hex } from "../evm/keys";
import { afterBroadcastError } from "./plan";

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

export function walletFor(clients: Clients, privateKey: Hex): WalletClient<Transport, Chain, Account> {
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: clients.chain,
    transport: http(clients.chain.rpcUrls.default.http[0], { retryCount: 0 }),
  });
}

export interface SendRequest {
  address: Hex;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/**
 * Simulate, sign locally, broadcast once, wait for the receipt. On a broadcast error the
 * chain is read (receipt, nonces) before deciding: a landed or pending tx is waited for,
 * an unsent one throws. Nothing is ever re-sent here.
 */
export async function sendContractTx(
  clients: Clients,
  wallet: WalletClient<Transport, Chain, Account>,
  req: SendRequest,
): Promise<TransactionReceipt> {
  const { reads } = clients;
  const account = wallet.account;
  const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
  const call = { account, to: req.address, data, value: req.value ?? BigInt(0) };
  // eth_call first: surfaces the revert reason before anything is signed.
  await reads.call(call);
  const prepared = await reads.prepareTransactionRequest({ ...call, chain: clients.chain });
  const serialized = await wallet.signTransaction(prepared);
  const hash = keccak256(serialized);
  try {
    await clients.broadcast.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    const txNonce = prepared.nonce;
    const receipt = await reads.getTransactionReceipt({ hash }).catch(() => undefined);
    const minedNonce = await reads.getTransactionCount({ address: account.address, blockTag: "latest" });
    const pendingNonce = await reads.getTransactionCount({ address: account.address, blockTag: "pending" });
    const outcome = afterBroadcastError({ txNonce, hasReceipt: receipt !== undefined, minedNonce, pendingNonce });
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (outcome === "not-sent") throw new Error(`${String(req.functionName)} not sent (${why}). Rerun.`);
    if (outcome === "nonce-taken") {
      throw new Error(`${String(req.functionName)}: nonce ${txNonce} used by another tx. Check ${account.address}.`);
    }
    console.log(`  broadcast errored (${why}) but tx ${hash} is ${outcome}; waiting for it`);
  }
  const receipt = await reads.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${String(req.functionName)} reverted: ${hash}`);
  return receipt;
}
