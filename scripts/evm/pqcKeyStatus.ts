// QoreChain pqcKeyStatus precompile (0x...0A02), hand-encoded so scripts/ needs no ABI library:
//   pqcKeyStatus(address) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)
import type { Hex } from "./keys";

export const PQC_KEY_STATUS_ADDRESS = "0x0000000000000000000000000000000000000A02";
/** bytes4(keccak256("pqcKeyStatus(address)")) */
const SELECTOR = "850dfe51";
/** algorithmId for ML-DSA-87 (Dilithium-5). */
export const ALGORITHM_ML_DSA_87 = 1;

export interface PqcKeyStatus {
  registered: boolean;
  algorithmId: number;
  pubkey: Uint8Array;
  possessionProven: boolean;
}

export function encodePqcKeyStatusCall(address: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not a 20-byte hex address: ${address}`);
  return `0x${SELECTOR}${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

export function decodePqcKeyStatus(ret: string): PqcKeyStatus {
  const data = ret.replace(/^0x/, "");
  const fail = (why: string) => new Error(`Bad pqcKeyStatus return value (${why}): ${data.length / 2} bytes`);
  const word = (i: number): bigint => {
    const w = data.slice(i * 64, i * 64 + 64);
    if (w.length !== 64) throw fail("truncated");
    return BigInt(`0x${w}`);
  };
  const offset = Number(word(2));
  if (offset % 32 !== 0) throw fail("unaligned pubkey offset");
  const length = Number(word(offset / 32));
  const start = offset * 2 + 64;
  const pubHex = data.slice(start, start + length * 2);
  if (pubHex.length !== length * 2) throw fail("truncated pubkey");
  return {
    registered: word(0) !== BigInt(0),
    algorithmId: Number(word(1)),
    pubkey: Uint8Array.from(Buffer.from(pubHex, "hex")),
    possessionProven: word(3) !== BigInt(0),
  };
}
