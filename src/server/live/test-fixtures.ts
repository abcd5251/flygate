import "server-only";
// Shared by the Live service tests: public test mnemonics and a FakeChain where Live can run.
import { derivePqcCanonical } from "@qorechain/sdk";
import { deriveEvmRole } from "../../../scripts/evm/keys";
import type { Env } from "./config";
import { FakeChain } from "./fake-chain";

// Public test mnemonics (BIP-39 vectors / Foundry default). Never real keys.
export const MNEMONICS = {
  OWNER_MNEMONIC: "test test test test test test test test test test test junk",
  AGENT_MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  MERCHANT_MNEMONIC: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
};
export const ESCROW = "0x1111111111111111111111111111111111111111";
export const DEPLOY_BLOCK = BigInt(100);
export const QOR = BigInt(1_000_000);

export const roles = Promise.all([
  deriveEvmRole("owner", MNEMONICS.OWNER_MNEMONIC),
  deriveEvmRole("agent", MNEMONICS.AGENT_MNEMONIC),
  deriveEvmRole("merchant", MNEMONICS.MERCHANT_MNEMONIC),
]).then(([owner, agent, merchant]) => ({
  owner,
  agent,
  merchant,
  merchantPqc: derivePqcCanonical(merchant.account.cosmos, MNEMONICS.MERCHANT_MNEMONIC),
}));

export function env(overrides: Env = {}): Env {
  return { LIVE_MODE: "on", ...MNEMONICS, FLIGHT_ESCROW_ADDRESS: ESCROW, FLIGHT_ESCROW_DEPLOY_BLOCK: DEPLOY_BLOCK.toString(), ...overrides };
}

/** A diana where everything Live needs is in place. */
export async function healthyChain(): Promise<FakeChain> {
  const r = await roles;
  return new FakeChain({
    chainId: 9800,
    code: { [ESCROW]: "0x6080604052" },
    pqc: {
      [r.merchant.account.evm.toLowerCase()]: {
        registered: true,
        algorithmId: 1,
        pubkey: r.merchantPqc.publicKey,
        possessionProven: true,
      },
      // The coin-60 signers' own keys (they send every EVM tx).
      [r.owner.signer.address.toLowerCase()]: { registered: true, algorithmId: 1, pubkey: new Uint8Array(2592), possessionProven: true },
      [r.agent.signer.address.toLowerCase()]: { registered: true, algorithmId: 1, pubkey: new Uint8Array(2592), possessionProven: true },
    },
    bank: { [r.owner.account.cosmos]: BigInt(60) * QOR, [r.agent.account.cosmos]: BigInt(20) * QOR },
    evm: {
      [r.owner.signer.address.toLowerCase()]: BigInt(10) ** BigInt(18),
      [r.agent.signer.address.toLowerCase()]: BigInt(10) ** BigInt(18),
    },
  });
}
