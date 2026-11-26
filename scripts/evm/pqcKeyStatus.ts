// QoreChain pqcKeyStatus precompile (0x...0A02), encoded and decoded with viem from the same
// signature FlightEscrow declares:
//   pqcKeyStatus(address) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)
import { decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi, type Address, type Hex } from "viem";

export const PQC_KEY_STATUS_ADDRESS = "0x0000000000000000000000000000000000000A02";
/** algorithmId for ML-DSA-87 (Dilithium-5). */
export const ALGORITHM_ML_DSA_87 = 1;

const abi = parseAbi([
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

export interface PqcKeyStatus {
  registered: boolean;
  algorithmId: number;
  pubkey: Uint8Array;
  possessionProven: boolean;
}

export function encodePqcKeyStatusCall(address: Address): Hex {
  return encodeFunctionData({ abi, functionName: "pqcKeyStatus", args: [address] });
}

export function decodePqcKeyStatus(ret: Hex): PqcKeyStatus {
  let decoded;
  try {
    decoded = decodeFunctionResult({ abi, functionName: "pqcKeyStatus", data: ret });
  } catch (err) {
    throw new Error(`Bad pqcKeyStatus return value (${(ret.length - 2) / 2} bytes): ${(err as Error).message.split("\n")[0]}`);
  }
  const [registered, algorithmId, pubkey, possessionProven] = decoded;
  return { registered, algorithmId, pubkey: hexToBytes(pubkey), possessionProven };
}
