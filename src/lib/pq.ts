import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";
import { canonicalJson } from "./mandate";
import type { PassengerInput } from "./types";

/**
 * Real post-quantum crypto running in the browser (FIPS 204 ML-DSA-87, FIPS 203 ML-KEM-1024).
 * Demo keys are generated per page load. In the full build the owner key lives in the
 * QoreX wallet, the merchant keys live on the merchant server, and pqcVerify runs on chain.
 */

type DsaKeys = { publicKey: Uint8Array; secretKey: Uint8Array };

let ownerKeys: DsaKeys | undefined;
let merchantKeys: DsaKeys | undefined;
let attackerKeys: DsaKeys | undefined;
let merchantKem: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined;

const enc = new TextEncoder();

function owner() {
  ownerKeys ??= ml_dsa87.keygen();
  return ownerKeys;
}
function merchant() {
  merchantKeys ??= ml_dsa87.keygen();
  return merchantKeys;
}
function attacker() {
  attackerKeys ??= ml_dsa87.keygen();
  return attackerKeys;
}
function kem() {
  merchantKem ??= ml_kem1024.keygen();
  return merchantKem;
}

export function toHex(bytes: Uint8Array, max?: number) {
  const slice = max ? bytes.slice(0, max) : bytes;
  return Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return `0x${toHex(new Uint8Array(digest))}`;
}

export type SignResult = {
  hash: string;
  sig: Uint8Array;
  sigBytes: number;
  pkBytes: number;
  ms: number;
  verified: boolean;
};

async function signWith(keys: DsaKeys, payload: unknown): Promise<SignResult> {
  const json = canonicalJson(payload);
  const hash = await sha256Hex(json);
  const t0 = performance.now();
  const msg = enc.encode(`qorechain-msg-v1|qorechain-diana|${hash}`);
  const sig = ml_dsa87.sign(msg, keys.secretKey);
  const ms = Math.round(performance.now() - t0);
  const verified = ml_dsa87.verify(sig, msg, keys.publicKey);
  return { hash, sig, sigBytes: sig.length, pkBytes: keys.publicKey.length, ms, verified };
}

export function signAsOwner(payload: unknown) {
  return signWith(owner(), payload);
}

export function signAsMerchant(payload: unknown) {
  return signWith(merchant(), payload);
}

/** Stand-in for the on-chain pqcVerify precompile: checks a signature against the merchant's registered key. */
export async function pqcVerifyMerchant(payload: unknown, sig: Uint8Array) {
  const hash = await sha256Hex(canonicalJson(payload));
  const msg = enc.encode(`qorechain-msg-v1|qorechain-diana|${hash}`);
  return ml_dsa87.verify(sig, msg, merchant().publicKey);
}

/**
 * Q-Day attack: the attacker broke the owner's classical key and signs a rule change
 * with a key they control. The chain checks the ML-DSA-87 half against the owner's
 * registered key, so verification fails.
 */
export async function forgeOwnerSignature(payload: unknown) {
  const forged = await signWith(attacker(), payload);
  const hash = await sha256Hex(canonicalJson(payload));
  const msg = enc.encode(`qorechain-msg-v1|qorechain-diana|${hash}`);
  const acceptedByChain = ml_dsa87.verify(forged.sig, msg, owner().publicKey);
  return { acceptedByChain, sigBytes: forged.sigBytes };
}

/** Encrypt passport data to the merchant's ML-KEM-1024 key, then AES-256-GCM with the shared secret. */
export async function encryptPassenger(p: PassengerInput) {
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(kem().publicKey);
  const key = await crypto.subtle.importKey("raw", sharedSecret as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(p)));
  const aes = new Uint8Array(body);
  return {
    kemCiphertextBytes: cipherText.length,
    aesCiphertextBytes: aes.length,
    preview: toHex(cipherText, 24),
  };
}

export function preview(sig: Uint8Array) {
  return `0x${toHex(sig, 20)}…`;
}

export const SIZES = {
  mlDsa87Sig: 4627,
  mlDsa87Pk: 2592,
  mlKem1024Ct: 1568,
};
