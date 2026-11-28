import "server-only";
import type { ChainStatus } from "@/lib/chain";
import { FLIGHT_ESCROW_ABI } from "@/lib/escrow";
import { canonicalJson, defaultMandate } from "@/lib/mandate";
import type { ChainTx } from "@/lib/types";
import { ALGORITHM_ML_DSA_87 } from "../../../scripts/evm/pqcKeyStatus";
import type { BroadcastOutcome, Hex, ServerChain } from "./chain";
import type { LiveConfig, LiveRole } from "./config";
import { deriveLiveKeys, mnemonicProblem, publicAddresses, type LiveKeys } from "./keys";
import {
  BadRequest,
  countUsedTickets,
  LIVE_MANDATE_STEPS,
  linkMsgs,
  mandateLimits,
  onchainMandate,
  parseMandate,
  parseMandateHash,
  setMandateData,
  STEP_TIMEOUT_MS,
  windowMsg,
  type LiveMandateStep,
} from "./mandate";
import { formatQor, MAX_FEE_UQOR, usdToUqor } from "./money";
import { bookSender, createCheckout, type CheckoutInput, type CheckoutResponse } from "./checkout";
import { txFactory, type Clock, type StepResult } from "./tx";

export { BadRequest };
export type { Clock };

export const DIANA_EVM_CHAIN_ID = 9800;
/** How long one status result is reused (D-27). */
export const STATUS_TTL_MS = 30_000;
/** Owner-paid Cosmos txs per demo round (link, window); their fees come on top of the fare. */
const OWNER_FEE_TXS = BigInt(2);

export type LiveStatus = ChainStatus & { checkedAt: number };

/** POST /api/live/mandate body: structured fields only; the server builds every tx from them (D-08). */
export interface SetupMandateInput {
  step: unknown;
  mandate: unknown;
  mandateHash: unknown;
}

/**
 * The server-side Live service. Its operations mirror `ChainPort`; Route Handlers are thin
 * adapters over it. /checkout runs one step per call (`checkout`); cancelBooking, checkFareCap and
 * the booking-state query arrive with #22-#24 as more checkout steps.
 */
export interface LiveService {
  status(): Promise<LiveStatus>;
  /**
   * One owner tx of a Live /mandate, in the fixed order link -> window -> mandate. Idempotent per
   * (mandate hash, step): a repeat gets the first call's result and never broadcasts again,
   * also after a failed broadcast. Throws BadRequest for malformed input.
   */
  setupMandate(input: SetupMandateInput): Promise<ChainTx>;
  /**
   * One step of a Live /checkout (quote, verify, lock, proof). Broadcasting steps are idempotent
   * per (step, bookingId). Throws BadRequest for malformed input.
   */
  checkout(input: CheckoutInput): Promise<CheckoutResponse>;
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
      // EVM txs come from the coin-60 signers: each needs its own registered ML-DSA-87 key.
      for (const role of ["owner", "agent"] as const) {
        const s = await chain.pqcKeyStatus(k.roles[role].signer.address);
        if (!s.registered || !s.possessionProven) fail(`${role === "owner" ? "Owner" : "Agent"} EVM signer has no registered ML-DSA-87 key with proof of possession (pnpm live:probe registers it)`);
      }
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

  function status(): Promise<LiveStatus> {
    const now = clock.now();
    if (!cached || now - cached.at >= STATUS_TTL_MS) {
      cached = { at: now, result: check().then((r) => ({ ...r, checkedAt: now })) };
    }
    return cached.result;
  }

  // ---------------------------------------------------------------- /mandate (#20)

  /** Idempotency table: mandate hash -> the mandate it was first used with and each step's result. */
  const sessions = new Map<Hex, { canonical: string; steps: Map<LiveMandateStep, Promise<StepResult>> }>();

  const txs = txFactory(clock, explorer);

  /** A failure found before anything was sent: not cached, so a later call may try again. */
  function refused(step: LiveMandateStep, code: string, reason: string): StepResult {
    return txs.refused("owner", STEP_TEXT[step], code, reason);
  }

  // Failed txs never get an explorer link or the "Live tx" label, only the chain's error code (D-20).
  function fromOutcome(fields: Pick<ChainTx, "label" | "msg">, o: BroadcastOutcome): StepResult {
    return txs.fromOutcome("owner", fields, o);
  }

  async function runStep(step: LiveMandateStep, m: ReturnType<typeof parseMandate>, mandateHash: Hex, prev?: Promise<StepResult>): Promise<StepResult> {
    if (prev) {
      const before = await prev;
      if (!before.tx.ok) return refused(step, "out of order", `The previous step failed (${before.tx.code}); nothing was sent`);
    }
    const st = await status();
    if (!st.available || !st.escrow) return refused(step, "live unavailable", st.reason ?? "Live is unavailable");
    const escrow = st.escrow as Hex;
    const k = await liveKeys();
    const owner = k.roles.owner.account;
    const limits = mandateLimits(m, config.uqorPerUsd, clock.now());
    if (limits.windowBlocks < 1) return refused(step, "mandate expired", "The mandate expires before a window could open; nothing was sent");

    // Tickets used so far (D-29). Read before the first broadcast, and again for setMandate.
    let used: number | undefined;
    if (step === "link" || step === "mandate") {
      if (config.deployBlock === undefined) {
        return refused(step, "ticket count unknown", "FLIGHT_ESCROW_DEPLOY_BLOCK is not set, so the tickets already used cannot be counted; nothing was sent");
      }
      try {
        used = await countUsedTickets(chain, escrow, config.deployBlock, bookSender(config.lane, k));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        return refused(step, "ticket count unknown", `Could not read Booked/Refunded logs (${why}), so the tickets already used are unknown; nothing was sent`);
      }
    }

    const opts = { timeoutMs: STEP_TIMEOUT_MS };
    switch (step) {
      case "link": {
        let alreadyLinked: boolean;
        try {
          const agentKey = k.roles.agent.signer.address.slice(2).toLowerCase();
          alreadyLinked = (await chain.linkedKeys(owner.cosmos)).some((l) => l.pubkeyHex === agentKey && !l.revoked);
        } catch (err) {
          return refused(step, "rpc error", `Could not read the owner's linked keys: ${err instanceof Error ? err.message : String(err)}`);
        }
        const msgs = linkMsgs({ owner: owner.cosmos, chainId: config.network.chainId, agentSigner: k.roles.agent.signer, escrow, limits, alreadyLinked });
        const fields = alreadyLinked
          ? { label: "Update spending rule (agent key already linked)", msg: "MsgUpdateSpendingRules" }
          : STEP_TEXT.link;
        return fromOutcome(fields, await chain.sendCosmos("owner", msgs, opts));
      }
      case "window":
        return fromOutcome(STEP_TEXT.window, await chain.sendCosmos("owner", [windowMsg({ owner: owner.cosmos, escrow, maxTickets: m.maxTickets, limits })], opts));
      case "mandate": {
        const mandate = onchainMandate(m, { merchant: k.roles.merchant.account.evm, used: used!, uqorPerUsd: config.uqorPerUsd, mandateHash });
        // agent = book()'s msg.sender: the owner account's 0x address on the authenticator lane
        // (ADR-0002), the agent's EOA on the eoa lane (D-11).
        const data = setMandateData(bookSender(config.lane, k), mandate);
        return fromOutcome(STEP_TEXT.mandate, await chain.sendEvm("owner", { to: escrow, data, errorAbi: FLIGHT_ESCROW_ABI }, opts));
      }
    }
  }

  async function setupMandate(input: SetupMandateInput): Promise<ChainTx> {
    const step = input.step;
    if (typeof step !== "string" || !(LIVE_MANDATE_STEPS as readonly string[]).includes(step)) {
      throw new BadRequest(`step must be one of ${LIVE_MANDATE_STEPS.join(", ")}`);
    }
    const s = step as LiveMandateStep;
    const m = parseMandate(input.mandate);
    const hash = parseMandateHash(input.mandateHash);
    const canonical = canonicalJson(m);

    let session = sessions.get(hash);
    if (session && session.canonical !== canonical) {
      return refused(s, "mandate mismatch", "This mandate hash was already used with a different mandate; nothing was sent").tx;
    }
    const existing = session?.steps.get(s);
    if (existing) return (await existing).tx;

    const i = LIVE_MANDATE_STEPS.indexOf(s);
    const prev = i > 0 ? session?.steps.get(LIVE_MANDATE_STEPS[i - 1]) : undefined;
    if (i > 0 && !prev) {
      return refused(s, "out of order", `Send "${LIVE_MANDATE_STEPS[i - 1]}" first; nothing was sent`).tx;
    }
    if (!session) {
      session = { canonical, steps: new Map() };
      sessions.set(hash, session);
    }
    // Sends never throw (ServerChain contract), so an exception is unexpected: keep it like a
    // failed broadcast rather than risk sending twice.
    const run = runStep(s, m, hash, prev).catch((err): StepResult => ({
      ...refused(s, "internal error", err instanceof Error ? err.message : String(err)),
      broadcast: true,
    }));
    session.steps.set(s, run);
    const result = await run;
    // Only results of a broadcast are kept: a refusal before sending may be tried again.
    if (!result.broadcast && session.steps.get(s) === run) session.steps.delete(s);
    return result.tx;
  }

  // ---------------------------------------------------------------- /checkout (#21)

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

  return { status, setupMandate, checkout: checkoutSteps.checkout };
}

const STEP_TEXT: Record<LiveMandateStep, Pick<ChainTx, "label" | "msg">> = {
  link: { label: "Link agent key + spending rule", msg: "MsgUpdateSpendingRules + MsgRegisterAuthenticator" },
  window: { label: "Open scoped window", msg: "MsgOpenEVMWindow" },
  mandate: { label: "Write mandate on-chain", msg: "FlightEscrow.setMandate()" },
};

