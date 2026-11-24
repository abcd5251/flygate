import type { ChainTx, TxKind } from "./types";

/**
 * Simulated QoreChain (diana testnet) layer. Every function here is a stand-in
 * for a real transaction; the message names match the QoreChain SDK so the
 * swap to real calls is one module.
 */

export const CHAIN = {
  name: "QoreChain diana",
  chainId: "qorechain-diana",
  evmChainId: 9800,
  explorer: "https://explore.qore.network",
};

export const ADDRESSES = {
  owner: "qor1u7x3k9p2m4d8f6h5j0l2n4q6s8t0v2w4y6z8k2f",
  agent: "qor1agt9w2e4r6t8y0u2i4o6p8a0s2d4f6g8h0j7k2",
  merchant: "qor1mrc5z7x9c1v3b5n7m9q1w3e5r7t9y1u3i5o3p8",
  /** FlightEscrow on diana (deployments/diana.json). */
  escrow: "0x7e9eCaBf07fAde561d4022A53ca7865c7531D97C",
  attacker: "0xbad0c0ffee000000000000000000000000dead00",
  pqcVerify: "0x0000000000000000000000000000000000000a01",
};

export const ERROR_CODES = {
  spending: { code: "abstractaccount 5", name: "spending_limit_exceeded" },
  permission: { code: "abstractaccount 10", name: "permission_denied" },
  replay: { code: "abstractaccount 11", name: "authenticator_replay" },
  expired: { code: "abstractaccount 6", name: "session_key_expired" },
  hybrid: { code: "pqc 21", name: "hybrid_verify_failed" },
  notLinked: { code: "abstractaccount 10", name: "authenticator not linked" },
};

export function shortAddr(a: string, head = 8, tail = 4) {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

export function fakeHash() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fakePnr() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

let seq = 0;
export function makeTx(label: string, msg: string, kind: TxKind, ok = true, code?: string): ChainTx {
  seq += 1;
  return { id: `tx_${Date.now()}_${seq}`, label, msg, hash: fakeHash(), kind, ok, code, at: Date.now() };
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const STARTING_BALANCE_USD = 1000;
