// Thin layer over @qorechain/sdk: client, per-role accounts, reads, and PQC registration.
import {
  clearPqcStatusCache,
  createClient,
  deriveNativeAccount,
  derivePqcCanonical,
  directSignerFromPrivateKey,
  ensurePqcRegistered,
  fetchPqcStatus,
  fromBase,
  QoreHttpError,
  withRetry,
  type EnsurePqcRegisteredResult,
  type PqcKeypair,
  type PqcStatus,
  type QoreChainClient,
  type Secp256k1Account,
  type TxClient,
} from "@qorechain/sdk";
import type { NetworkSettings, Role } from "./env";

export const DENOM = "uqor";

export interface RoleAccount {
  role: Role;
  address: string;
  account: Secp256k1Account;
  pqcKeypair: PqcKeypair;
}

export function makeClient(network: NetworkSettings): QoreChainClient {
  return createClient({
    network: "testnet",
    chainId: network.chainId,
    endpoints: { rpc: network.rpc, rest: network.rest, evmRpc: network.evmRpc },
  });
}

/** Both keys come from the one mnemonic: secp256k1 account, then the address-bound ML-DSA-87 key. */
export async function deriveRole(role: Role, mnemonic: string): Promise<RoleAccount> {
  const account = await deriveNativeAccount(mnemonic);
  const pqcKeypair = derivePqcCanonical(account.address, mnemonic);
  return { role, address: account.address, account, pqcKeypair };
}

function isRateLimited(err: unknown): boolean {
  if (err instanceof QoreHttpError) return err.status === 429;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|too many requests|rate.?limit/i.test(msg);
}

/** Retry public-endpoint calls on rate limiting: up to 3 retries, 1s/2s/4s. */
export function retrying<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(() => fn(), {
    retries: 3,
    backoff: 1000,
    maxBackoff: 8000,
    shouldRetry: (err) => isRateLimited(err),
  });
}

/** Balance in base units (uqor). */
export async function balanceOf(client: QoreChainClient, address: string): Promise<bigint> {
  const res = await retrying(() => client.rest.getAllBalances(address));
  const coin = res.balances.find((c) => c.denom === DENOM);
  return coin ? BigInt(coin.amount) : BigInt(0);
}

export function formatQor(base: bigint): string {
  return `${fromBase(base.toString())} QOR`;
}

export async function pqcStatusOf(network: NetworkSettings, address: string): Promise<PqcStatus> {
  clearPqcStatusCache();
  return retrying(() => fetchPqcStatus({ rest: network.rest, address }));
}

/** A tx client that hybrid-signs every transaction with the role's ML-DSA-87 key. */
export async function connect(client: QoreChainClient, who: RoleAccount): Promise<TxClient> {
  const signer = await directSignerFromPrivateKey(who.account.privateKey, "qor");
  return retrying(() => client.connectTx(signer, { pqcKeypair: who.pqcKeypair }));
}

/**
 * Idempotent ML-DSA-87 registration with proof of possession. Never passes `force`:
 * a duplicate registration is charged and then refused. Throws PqcKeyMismatchError
 * if the chain holds a different key.
 */
export async function registerPqc(
  network: NetworkSettings,
  tx: TxClient,
  who: RoleAccount,
): Promise<EnsurePqcRegisteredResult> {
  // Each attempt re-reads status uncached, so a retry after a landed tx is a no-op.
  return retrying(() => {
    clearPqcStatusCache();
    return ensurePqcRegistered(tx, { pqcKeypair: who.pqcKeypair, rest: network.rest, chainId: network.chainId });
  });
}
