import "server-only";
import type { ChainStatus, ClosePlan, MandatePlan, OwnerState, WalletMessage } from "@/lib/chain";
import type { ChainTx } from "@/lib/types";
import { ALGORITHM_ML_DSA_87 } from "../../../scripts/evm/pqcKeyStatus";
import type { Hex, ServerChain } from "./chain";
import type { LiveConfig, LiveRole } from "./config";
import { deriveLiveKeys, mnemonicProblem, publicAddresses, type LiveKeys } from "./keys";
import {
  BadRequest,
  CLOSE_MANDATE_GAS,
  closeMandateMessages,
  depositForUqor,
  mandateHashOf,
  onchainMandate,
  OPEN_MANDATE_GAS,
  openMandateMessages,
  parseControlHash,
  parseMandate,
  parseOwner,
  readMandate,
  WALLET_TX_TIMEOUT_MS,
  type MandateState,
  type OwnerAccount,
} from "./mandate";
import { formatQor, WEI_PER_UQOR } from "./money";
import { createCheckout, type CheckoutInput, type CheckoutResponse } from "./checkout";
import { errorText, txFactory, type Clock } from "./tx";

export { BadRequest };
export type { Clock };

export const DIANA_EVM_CHAIN_ID = 9800;
/** How long one status result is reused (D-27). */
export const STATUS_TTL_MS = 30_000;
/**
 * Least the agent's EVM signer must hold: it pays the gas of book(), confirmTicket() and cancel()
 * and of its own EVM windows (about 0.075 QOR per window on diana).
 */
export const AGENT_MIN_GAS_UQOR = BigInt(500_000);

export type LiveStatus = ChainStatus & { checkedAt: number };

/** POST /api/live/mandate body: structured fields only; the server builds every message itself (D-08). */
export interface MandateInput {
  action: unknown;
  mandate?: unknown;
  owner?: unknown;
  controlHash?: unknown;
  txHash?: unknown;
}

export type MandateResponse = MandatePlan | ClosePlan | OwnerState | ChainTx;

/**
 * The server-side Live service. Route Handlers are thin adapters over it. The owner's
 * transactions are signed by the owner's own wallet; this only builds them and reads back what
 * landed (ADR-0003). It sends only as FlyGate's agent (book, confirmTicket, cancel).
 */
export interface LiveService {
  status(): Promise<LiveStatus>;
  /**
   * The owner's side of /mandate: `prepare` builds the wallet tx (deposit + openMandate),
   * `confirm` waits for it and checks the mandate on chain, `close` builds closeMandate,
   * `closed` waits for that, and `state` reads the owner's balance and mandate.
   */
  mandate(input: MandateInput): Promise<MandateResponse>;
  /** One step of a Live /checkout. Broadcasting steps are idempotent per (step, bookingId). */
  checkout(input: CheckoutInput): Promise<CheckoutResponse>;
}

export interface LiveServiceDeps {
  chain: ServerChain;
  config: LiveConfig;
  clock: Clock;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const COSMOS_TX_RE = /^[0-9A-Fa-f]{64}$/;

class Unavailable extends Error {}
const fail = (reason: string): never => {
  throw new Unavailable(reason);
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const qorNumber = (uqor: bigint) => formatQor(uqor).replace(/ QOR$/, "");

export function createLiveService({ chain, config, clock }: LiveServiceDeps): LiveService {
  const explorer = config.network.explorer;
  let keys: Promise<LiveKeys> | undefined;
  let cached: { at: number; result: Promise<LiveStatus> } | undefined;
  const txs = txFactory(clock, explorer);

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

      // The agent's coin-60 signer sends every server tx and pays its gas.
      const agent = k.roles.agent.signer.address;
      const s = await chain.pqcKeyStatus(agent);
      if (!s.registered || !s.possessionProven) fail("Agent EVM signer has no registered ML-DSA-87 key with proof of possession (pnpm live:probe registers it)");
      const gas = (await chain.evmBalance(agent)) / WEI_PER_UQOR;
      if (gas < AGENT_MIN_GAS_UQOR) {
        fail(`FlyGate's agent has ${formatQor(gas)} for gas, below ${formatQor(AGENT_MIN_GAS_UQOR)}: top up ${agent} before taking bookings`);
      }
      return { available: true, escrow, explorer, addresses };
    } catch (err) {
      const reason = err instanceof Unavailable ? err.message : `Chain read failed: ${errorText(err)}`;
      return { available: false, reason, escrow, explorer, addresses };
    }
  }

  function status(): Promise<LiveStatus> {
    const now = clock.now();
    if (!cached || now - cached.at >= STATUS_TTL_MS) {
      cached = { at: now, result: check().then((r) => ({ ...r, checkedAt: now })) };
    }
    return cached.result;
  }

  /** The escrow and agent when Live can run, else why not. */
  async function live(): Promise<{ escrow: Hex; k: LiveKeys } | { code: string; reason: string }> {
    const st = await status();
    if (!st.available || !st.escrow) return { code: "live unavailable", reason: st.reason ?? "Live is unavailable" };
    return { escrow: st.escrow as Hex, k: await liveKeys() };
  }

  // ---------------------------------------------------------------- /mandate (owner's wallet)

  const request = (messages: WalletMessage[], gasLimit: number, memo: string) => ({ chainId: config.network.chainId, messages, gasLimit, memo });

  async function prepare(input: MandateInput): Promise<MandatePlan> {
    const m = parseMandate(input.mandate);
    const owner = parseOwner(input.owner);
    const controlHash = parseControlHash(input.controlHash);
    if (Date.parse(m.expiresAt) <= clock.now()) return { ok: false, code: "mandate expired", reason: "The mandate's expiry is in the past; pick a later one" };
    const l = await live();
    if (!("escrow" in l)) return { ok: false, ...l };
    const agent = l.k.roles.agent.signer.address;
    let current: MandateState;
    try {
      current = await readMandate(chain, l.escrow, owner.evm, agent);
    } catch (err) {
      return { ok: false, code: "rpc error", reason: `Could not read your current mandate: ${errorText(err)}` };
    }
    const mandateHash = mandateHashOf({ mandate: m, owner: owner.evm, agent, controlHash });
    const onchain = onchainMandate(m, { merchant: l.k.roles.merchant.account.evm, used: current.ticketsUsed, uqorPerUsd: config.uqorPerUsd, mandateHash });
    // Top the budget up to what this mandate can spend; never deposit more than that.
    const need = depositForUqor(m, config.uqorPerUsd);
    const have = current.budgetWei / WEI_PER_UQOR;
    const depositUqor = need > have ? need - have : BigInt(0);
    return {
      ok: true,
      request: request(openMandateMessages({ owner, escrow: l.escrow, agent, mandate: onchain, depositUqor }), OPEN_MANDATE_GAS, "FlyGate: deposit + flight mandate"),
      mandateHash,
      owner,
      agent,
      escrow: l.escrow,
      depositQor: qorNumber(depositUqor),
      budgetQor: qorNumber(have + depositUqor),
      ticketsUsed: current.ticketsUsed,
    };
  }

  /** Waits for the owner's wallet tx. A ChainTx failure when it did not land as code 0. */
  async function walletTx(txHash: string, text: { label: string; msg: string }): Promise<ChainTx | undefined> {
    let included;
    try {
      included = await chain.cosmosTx(txHash, WALLET_TX_TIMEOUT_MS);
    } catch (err) {
      return txs.refused("owner", text, "rpc error", `Could not read your wallet's transaction ${txHash}: ${errorText(err)}`).tx;
    }
    if (!included) return txs.refused("owner", text, "timeout", `Your wallet's transaction ${txHash} was not included within ${WALLET_TX_TIMEOUT_MS / 1000} s`).tx;
    if (included.code !== 0) {
      return txs.fromOutcome("owner", text, { status: "reverted", lane: "cosmos", hash: txHash, code: `code ${included.code}`, reason: included.rawLog ?? "" }).tx;
    }
    return undefined;
  }

  function parseTxHash(raw: unknown): string {
    if (typeof raw !== "string" || !COSMOS_TX_RE.test(raw)) throw new BadRequest("txHash must be a 64-character hex Cosmos tx hash");
    return raw.toUpperCase();
  }

  const OPEN_TEXT = { label: "Deposit + mandate (signed in QoreX)", msg: "MsgSend + MsgCrossVMCall → FlightEscrow.openMandate()" };
  const CLOSE_TEXT = { label: "Close mandate + withdraw (signed in QoreX)", msg: "MsgCrossVMCall → FlightEscrow.closeMandate()" };

  async function confirm(input: MandateInput): Promise<ChainTx> {
    const m = parseMandate(input.mandate);
    const owner = parseOwner(input.owner);
    const controlHash = parseControlHash(input.controlHash);
    const txHash = parseTxHash(input.txHash);
    const l = await live();
    if (!("escrow" in l)) return txs.refused("owner", OPEN_TEXT, l.code, l.reason).tx;
    const failed = await walletTx(txHash, OPEN_TEXT);
    if (failed) return failed;
    const agent = l.k.roles.agent.signer.address;
    const expected = mandateHashOf({ mandate: m, owner: owner.evm, agent, controlHash });
    let state: MandateState;
    try {
      state = await readMandate(chain, l.escrow, owner.evm, agent);
    } catch (err) {
      return txs.refused("owner", OPEN_TEXT, "rpc error", `Your transaction landed, but the mandate could not be read back: ${errorText(err)}`).tx;
    }
    if (!state.exists || state.revoked || state.mandateHash.toLowerCase() !== expected) {
      return txs.refused("owner", OPEN_TEXT, "mandate mismatch", `Your transaction ${txHash} landed, but FlightEscrow does not hold this mandate for your account`).tx;
    }
    return txs.fromOutcome("owner", OPEN_TEXT, { status: "success", lane: "cosmos", hash: txHash }).tx;
  }

  async function close(input: MandateInput): Promise<ClosePlan> {
    const owner = parseOwner(input.owner);
    const l = await live();
    if (!("escrow" in l)) return { ok: false, ...l };
    const agent = l.k.roles.agent.signer.address;
    try {
      const state = await readMandate(chain, l.escrow, owner.evm, agent);
      if (!state.exists) return { ok: false, code: "no mandate", reason: "Your account has no mandate for FlyGate's agent" };
      return {
        ok: true,
        request: request(closeMandateMessages({ owner, escrow: l.escrow, agent }), CLOSE_MANDATE_GAS, "FlyGate: close mandate + withdraw"),
        refundQor: qorNumber(state.budgetWei / WEI_PER_UQOR),
      };
    } catch (err) {
      return { ok: false, code: "rpc error", reason: `Could not read your mandate: ${errorText(err)}` };
    }
  }

  async function closed(input: MandateInput): Promise<ChainTx> {
    const owner = parseOwner(input.owner);
    const txHash = parseTxHash(input.txHash);
    const l = await live();
    if (!("escrow" in l)) return txs.refused("owner", CLOSE_TEXT, l.code, l.reason).tx;
    const failed = await walletTx(txHash, CLOSE_TEXT);
    if (failed) return failed;
    try {
      const state = await readMandate(chain, l.escrow, owner.evm, l.k.roles.agent.signer.address);
      if (!state.revoked) return txs.refused("owner", CLOSE_TEXT, "still open", `Your transaction ${txHash} landed, but the mandate is still open`).tx;
    } catch (err) {
      return txs.refused("owner", CLOSE_TEXT, "rpc error", `Your transaction landed, but the mandate could not be read back: ${errorText(err)}`).tx;
    }
    return txs.fromOutcome("owner", CLOSE_TEXT, { status: "success", lane: "cosmos", hash: txHash }).tx;
  }

  async function ownerState(input: MandateInput): Promise<OwnerState> {
    const owner: OwnerAccount = parseOwner(input.owner);
    const l = await live();
    if (!("escrow" in l)) return { ok: false, ...l };
    try {
      const [balance, state] = await Promise.all([chain.bankBalance(owner.cosmos), readMandate(chain, l.escrow, owner.evm, l.k.roles.agent.signer.address)]);
      return {
        ok: true,
        owner,
        balanceQor: qorNumber(balance),
        mandate: state.exists
          ? {
              revoked: state.revoked,
              budgetQor: qorNumber(state.budgetWei / WEI_PER_UQOR),
              ticketsUsed: state.ticketsUsed,
              maxTickets: state.maxTickets,
              mandateHash: state.mandateHash,
              expiresAt: Number(state.expiresAt),
            }
          : undefined,
      };
    } catch (err) {
      return { ok: false, code: "rpc error", reason: `Could not read your account: ${errorText(err)}` };
    }
  }

  async function mandate(input: MandateInput): Promise<MandateResponse> {
    switch (input.action) {
      case "prepare":
        return prepare(input);
      case "confirm":
        return confirm(input);
      case "close":
        return close(input);
      case "closed":
        return closed(input);
      case "state":
        return ownerState(input);
      default:
        throw new BadRequest("action must be one of prepare, confirm, close, closed, state");
    }
  }

  // ---------------------------------------------------------------- /checkout

  const checkoutSteps = createCheckout({
    chain,
    config,
    clock,
    keys: liveKeys,
    async liveEscrow() {
      const st = await status();
      if (!st.available || !st.escrow) return { code: "live unavailable", reason: st.reason ?? "Live is unavailable" };
      return { escrow: st.escrow as Hex };
    },
  });

  return { status, mandate, checkout: checkoutSteps.checkout };
}
