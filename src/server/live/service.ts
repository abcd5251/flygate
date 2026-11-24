import "server-only";
import type { ChainStatus } from "@/lib/chain";
import { defaultMandate } from "@/lib/mandate";
import { ALGORITHM_ML_DSA_87 } from "../../../scripts/evm/pqcKeyStatus";
import type { Hex, ServerChain } from "./chain";
import type { LiveConfig, LiveRole } from "./config";
import { deriveLiveKeys, mnemonicProblem, publicAddresses, type LiveKeys } from "./keys";
import { formatQor, MAX_FEE_UQOR, usdToUqor } from "./money";

export const DIANA_EVM_CHAIN_ID = 9800;
/** How long one status result is reused (D-27). */
export const STATUS_TTL_MS = 30_000;
/** Owner-paid Cosmos txs per demo round (link, window); their fees come on top of the fare. */
const OWNER_FEE_TXS = BigInt(2);

export interface Clock {
  now(): number;
}

export type LiveStatus = ChainStatus & { checkedAt: number };

/**
 * The server-side Live service. Its operations mirror `ChainPort`; Route Handlers are thin
 * adapters over it. This ticket has `status`; setupMandate, lockFunds, confirmTicket,
 * cancelBooking, checkFareCap and the booking-state query arrive with #20-#24.
 */
export interface LiveService {
  status(): Promise<LiveStatus>;
}

export interface LiveServiceDeps {
  chain: ServerChain;
  config: LiveConfig;
  clock: Clock;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

class Unavailable extends Error {}
const fail = (reason: string): never => {
  throw new Unavailable(reason);
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function createLiveService({ chain, config, clock }: LiveServiceDeps): LiveService {
  const explorer = config.network.explorer;
  let keys: Promise<LiveKeys> | undefined;
  let cached: { at: number; result: Promise<LiveStatus> } | undefined;

  function liveKeys(): Promise<LiveKeys> {
    keys ??= deriveLiveKeys(config.mnemonics as Record<LiveRole, string>);
    return keys;
  }

  async function check(): Promise<Omit<LiveStatus, "checkedAt">> {
    let addresses: ChainStatus["addresses"];
    let escrow: string | undefined;
    try {
      if (!config.liveMode) fail("LIVE_MODE is not on");
      const mnemonics = mnemonicProblem(config.mnemonics);
      if (mnemonics) fail(mnemonics);
      if (config.problems.length > 0) fail(config.problems[0]);

      const k = await liveKeys();
      addresses = publicAddresses(k);

      const raw = config.escrowAddress;
      if (!raw) fail("FlightEscrow not deployed (FLIGHT_ESCROW_ADDRESS is not set)");
      if (!ADDRESS_RE.test(raw!)) fail("FLIGHT_ESCROW_ADDRESS is not a valid 0x address");
      const address = raw as Hex;

      const chainId = await chain.evmChainId();
      if (chainId !== DIANA_EVM_CHAIN_ID) fail(`EVM chain id is ${chainId}, expected ${DIANA_EVM_CHAIN_ID}`);
      const code = await chain.getCode(address);
      if (!/^0x[0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*$/.test(code)) fail(`FlightEscrow not deployed (no code at ${address})`);
      escrow = address;

      const merchant = k.roles.merchant.account;
      const pqc = await chain.pqcKeyStatus(merchant.evm);
      if (!pqc.registered) fail("Merchant ML-DSA-87 key is not registered on-chain (run pnpm bootstrap)");
      if (pqc.algorithmId !== ALGORITHM_ML_DSA_87) fail(`Merchant PQC key has algorithmId ${pqc.algorithmId}, expected ${ALGORITHM_ML_DSA_87} (ML-DSA-87)`);
      if (!pqc.possessionProven) fail("Merchant PQC key has no proof of possession");
      if (!sameBytes(pqc.pubkey, k.merchantPqc.publicKey)) fail("Merchant on-chain ML-DSA-87 key does not match MERCHANT_MNEMONIC");

      const fare = usdToUqor(defaultMandate().maxFareUsd, config.uqorPerUsd);
      const ownerNeeds = fare + MAX_FEE_UQOR * OWNER_FEE_TXS;
      const ownerHas = await chain.bankBalance(k.roles.owner.account.cosmos);
      if (ownerHas < ownerNeeds) {
        fail(`Owner balance ${formatQor(ownerHas)} is below one max fare plus fees (${formatQor(ownerNeeds)})`);
      }
      const zero = BigInt(0);
      if ((await chain.bankBalance(k.roles.agent.account.cosmos)) <= zero) fail("Relayer (agent account) has no balance");
      if ((await chain.evmBalance(k.roles.owner.signer.address)) <= zero) fail("Owner EVM signer has no balance (it sends setMandate)");
      if ((await chain.evmBalance(k.roles.agent.signer.address)) <= zero) {
        fail("Agent EVM signer has no balance (it sends confirmTicket and cancel)");
      }
      return { available: true, escrow, explorer, addresses };
    } catch (err) {
      const reason = err instanceof Unavailable ? err.message : `Chain read failed: ${err instanceof Error ? err.message : String(err)}`;
      return { available: false, reason, escrow, explorer, addresses };
    }
  }

  return {
    status() {
      const now = clock.now();
      if (!cached || now - cached.at >= STATUS_TTL_MS) {
        cached = { at: now, result: check().then((r) => ({ ...r, checkedAt: now })) };
      }
      return cached.result;
    },
  };
}

