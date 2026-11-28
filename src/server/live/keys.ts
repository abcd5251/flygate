import "server-only";
import { derivePqcCanonical, validateMnemonic, type PqcKeypair } from "@qorechain/sdk";
import { deriveEvmRole, type EvmRole } from "../../../scripts/evm/keys";
import type { LiveAddresses } from "@/lib/types";
import { LIVE_ROLES, MNEMONIC_VARS, type LiveRole } from "./config";

/** Every key the Live server signs with. Secrets: never log, return or serialize this. */
export interface LiveKeys {
  roles: Record<LiveRole, EvmRole>;
  /** The merchant's bootstrap-registered ML-DSA-87 key (D-32). */
  merchantPqc: PqcKeypair;
}

/** Which mnemonic variables are missing or invalid, by variable name only. */
export function mnemonicProblem(mnemonics: Partial<Record<LiveRole, string>>): string | undefined {
  const missing = LIVE_ROLES.filter((r) => !mnemonics[r]).map((r) => MNEMONIC_VARS[r]);
  if (missing.length > 0) return `Missing ${missing.join(", ")} (run pnpm bootstrap)`;
  const invalid = LIVE_ROLES.filter((r) => !validateMnemonic(mnemonics[r]!)).map((r) => MNEMONIC_VARS[r]);
  if (invalid.length > 0) return `${invalid.join(", ")} is not a valid BIP-39 mnemonic`;
  return undefined;
}

export async function deriveLiveKeys(mnemonics: Record<LiveRole, string>): Promise<LiveKeys> {
  const roles = {} as Record<LiveRole, EvmRole>;
  for (const role of LIVE_ROLES) roles[role] = await deriveEvmRole(role, mnemonics[role]);
  return {
    roles,
    merchantPqc: derivePqcCanonical(roles.merchant.account.cosmos, mnemonics.merchant),
  };
}

/** The public half of `LiveKeys`, built field by field so no secret can slip in. */
export function publicAddresses(keys: LiveKeys): LiveAddresses {
  const { agent, merchant } = keys.roles;
  return {
    agent: { account: { ...agent.account }, signer: agent.signer.address },
    merchant: { account: { ...merchant.account } },
  };
}
