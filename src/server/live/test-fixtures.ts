import "server-only";
// Shared by the Live service tests: public test mnemonics and a FakeChain where Live can run.
import { derivePqcCanonical } from "@qorechain/sdk";
import { keccak256, type Hex } from "viem";
import { defaultMandate } from "@/lib/mandate";
import { deriveEvmRole } from "../../../scripts/evm/keys";
import type { Env } from "./config";
import { FakeChain } from "./fake-chain";
import { mandateHashOf } from "./mandate";

// Public test mnemonics (BIP-39 vectors / Foundry default). Never real keys. The owner's stands in
// for a QoreX wallet: the server is never given it (env() leaves it out).
export const MNEMONICS = {
  AGENT_MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  MERCHANT_MNEMONIC: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
};
const OWNER_WALLET_MNEMONIC = "test test test test test test test test test test test junk";
export const ESCROW = "0x1111111111111111111111111111111111111111";
export const DEPLOY_BLOCK = BigInt(100);
export const QOR = BigInt(1_000_000);
export const WEI_PER_QOR = BigInt(10) ** BigInt(18);
/** The session key the owner's browser set the default mandate with, and its hash. */
export const SESSION_KEY = `0x${"5e".repeat(32)}` as Hex;
export const CONTROL_HASH = keccak256(SESSION_KEY);
/** A wallet tx hash the owner's QoreX returned. */
export const WALLET_TX = "AB".repeat(32);

export const roles = Promise.all([
  deriveEvmRole("owner", OWNER_WALLET_MNEMONIC),
  deriveEvmRole("agent", MNEMONICS.AGENT_MNEMONIC),
  deriveEvmRole("merchant", MNEMONICS.MERCHANT_MNEMONIC),
]).then(([owner, agent, merchant]) => ({
  /** The owner's QoreX account (qor1) and its EVM view; the owner has no other key here. */
  owner: owner.account,
  agent,
  merchant,
  merchantPqc: derivePqcCanonical(merchant.account.cosmos, MNEMONICS.MERCHANT_MNEMONIC),
}));

export function env(overrides: Env = {}): Env {
  return { LIVE_MODE: "on", ...MNEMONICS, FLIGHT_ESCROW_ADDRESS: ESCROW, FLIGHT_ESCROW_DEPLOY_BLOCK: DEPLOY_BLOCK.toString(), ...overrides };
}

/** The on-chain hash of `mandate` set by the test owner for the agent with SESSION_KEY. */
export async function defaultMandateHash(mandate = defaultMandate()): Promise<Hex> {
  const r = await roles;
  return mandateHashOf({ mandate, owner: r.owner.evm, agent: r.agent.signer.address, controlHash: CONTROL_HASH });
}

/** `mandates` key of the test owner's slot for the agent. */
export async function ownerSlot(): Promise<string> {
  const r = await roles;
  return `${r.owner.evm.toLowerCase()}/${r.agent.signer.address.toLowerCase()}`;
}

/**
 * A diana where everything Live needs is in place, and the test owner already holds the default
 * mandate (set with SESSION_KEY) with a 10 QOR budget.
 */
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
      // The agent's coin-60 signer sends every server tx.
      [r.agent.signer.address.toLowerCase()]: { registered: true, algorithmId: 1, pubkey: new Uint8Array(2592), possessionProven: true },
    },
    bank: { [r.owner.cosmos]: BigInt(60) * QOR },
    evm: { [r.agent.signer.address.toLowerCase()]: WEI_PER_QOR },
    mandates: {
      [await ownerSlot()]: {
        budgetWei: BigInt(10) * WEI_PER_QOR,
        mandateHash: await defaultMandateHash(),
        maxTickets: 1,
        expiresAt: BigInt(Math.floor(Date.parse(defaultMandate().expiresAt) / 1000)),
      },
    },
  });
}
