import "server-only";
import { linkAuthenticatorMsgs, openEvmWindowMsg, signAuthenticatorLinkEip191 } from "@qorechain/sdk";
import { hexToBytes, pad } from "viem";
import { bookingIdOfBook, Cabin as EscrowCabin, encodeSetMandate, EVENT_TOPICS, SELECTORS, unixDay, type OnchainMandate } from "@/lib/escrow";
import { PLACES } from "@/lib/mandate";
import type { Cabin, Mandate } from "@/lib/types";
import type { CosmosMsg, Hex, ServerChain } from "./chain";
import { MAX_FEE_UQOR, usdToUqor, WEI_PER_UQOR } from "./money";

/**
 * The three owner transactions of a Live /mandate, in their fixed order (D-12): link the agent
 * key with its spending rule (Cosmos), open the Scoped window on the owner account (Cosmos), then
 * setMandate (EVM) from the owner's coin-60 signer, which needs its own EVM window (`sendEvm`
 * opens it).
 */
export const LIVE_MANDATE_STEPS = ["link", "window", "mandate"] as const;
export type LiveMandateStep = (typeof LIVE_MANDATE_STEPS)[number];

/** Longest wait for one Live step (D-30). */
export const STEP_TIMEOUT_MS = 30_000;
/** A Scoped window stays open at most ~1 hour (D-12). */
export const WINDOW_MAX_BLOCKS = 3_600;
/** diana makes a block about every second (docs/FLOW.md); used to turn time into blocks. */
export const BLOCK_SECONDS = 1;
export const SPENDING_RULE_ID = "flygate-live";

/** A request the server refuses to act on (HTTP 400). Never reaches the chain. */
export class BadRequest extends Error {}

const CABINS: Record<Cabin, EscrowCabin> = { economy: EscrowCabin.Economy, premium: EscrowCabin.PremiumEconomy, business: EscrowCabin.Business };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The mandate from a request body, checked field by field. Cities must be demo places (the
 * server rebuilds them from PLACES, so only the code is trusted).
 */
export function parseMandate(raw: unknown): Mandate {
  if (!isRecord(raw)) throw new BadRequest("mandate must be an object");
  const city = (key: "origin" | "destination") => {
    const v = raw[key];
    const code = isRecord(v) ? v.code : undefined;
    if (typeof code !== "string" || !PLACES[code]) throw new BadRequest(`mandate.${key} is not a demo city`);
    return PLACES[code];
  };
  const date = (key: "departFrom" | "departTo") => {
    const v = raw[key];
    if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new BadRequest(`mandate.${key} is not a YYYY-MM-DD date`);
    return v;
  };
  const int = (key: "maxFareUsd" | "maxTickets" | "passengers", max: number) => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new BadRequest(`mandate.${key} must be a whole number from 1 to ${max}`);
    return v;
  };
  const bool = (key: "refundableOnly" | "directOnly") => {
    if (typeof raw[key] !== "boolean") throw new BadRequest(`mandate.${key} must be true or false`);
    return raw[key] as boolean;
  };
  const cabin = raw.cabin;
  if (typeof cabin !== "string" || !(cabin in CABINS)) throw new BadRequest("mandate.cabin is not a cabin");
  const expiresAt = raw.expiresAt;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) throw new BadRequest("mandate.expiresAt is not a date");
  const m: Mandate = {
    origin: city("origin"),
    destination: city("destination"),
    departFrom: date("departFrom"),
    departTo: date("departTo"),
    cabin: cabin as Cabin,
    refundableOnly: bool("refundableOnly"),
    directOnly: bool("directOnly"),
    maxFareUsd: int("maxFareUsd", 100_000),
    maxTickets: int("maxTickets", 9),
    passengers: int("passengers", 9),
    expiresAt,
  };
  if (m.departTo < m.departFrom) throw new BadRequest("mandate.departTo is before departFrom");
  return m;
}

export function parseMandateHash(raw: unknown): Hex {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new BadRequest("mandateHash must be a 32-byte 0x hash");
  return raw.toLowerCase() as Hex;
}

/** The chain limits a mandate becomes (D-12, D-13, D-14). Amounts in uqor. */
export interface MandateLimits {
  perTxLimit: bigint;
  dailyLimit: bigint;
  windowMaxValue: bigint;
  windowBlocks: number;
  expiryUnix: number;
}

export function mandateLimits(m: Mandate, uqorPerUsd: bigint, nowMs: number): MandateLimits {
  const perTxLimit = usdToUqor(m.maxFareUsd, uqorPerUsd);
  const tickets = BigInt(m.maxTickets);
  const expiryUnix = Math.floor(Date.parse(m.expiresAt) / 1000);
  const secondsLeft = expiryUnix - Math.floor(nowMs / 1000);
  return {
    perTxLimit,
    dailyLimit: perTxLimit * tickets,
    windowMaxValue: (perTxLimit + MAX_FEE_UQOR) * tickets,
    windowBlocks: Math.min(WINDOW_MAX_BLOCKS, Math.floor(secondsLeft / BLOCK_SECONDS)),
    expiryUnix,
  };
}

/** The one EVM call the spending rule allows: FlightEscrow.book() (never setMandate / revokeMandate). */
export function bookOnlyCall(escrow: Hex): string {
  return `${escrow.toLowerCase()}/${SELECTORS.book.toLowerCase()}`;
}

/** Step 1: [MsgUpdateSpendingRules, MsgRegisterAuthenticator], or just the rules when already linked. */
export function linkMsgs(o: {
  owner: string;
  chainId: string;
  agentSigner: { address: Hex; privateKey: Hex };
  escrow: Hex;
  limits: MandateLimits;
  alreadyLinked: boolean;
}): CosmosMsg[] {
  const proof = signAuthenticatorLinkEip191({ chainId: o.chainId, account: o.owner, privateKey: o.agentSigner.privateKey });
  const msgs = linkAuthenticatorMsgs({
    owner: o.owner,
    chainId: o.chainId,
    scheme: "secp256k1",
    pubkey: hexToBytes(o.agentSigner.address),
    permissions: ["evm"],
    expiryUnix: o.limits.expiryUnix,
    label: "flygate-agent",
    possessionProof: proof.possessionProof,
    // The whole rule set, every time: MsgUpdateSpendingRules replaces it wholesale (D-13).
    spendingRule: {
      id: SPENDING_RULE_ID,
      perTxLimit: o.limits.perTxLimit,
      dailyLimit: o.limits.dailyLimit,
      enabled: true,
      allowedEvmCalls: [bookOnlyCall(o.escrow)],
    },
  });
  return o.alreadyLinked ? msgs.filter((m) => !m.typeUrl.endsWith("MsgRegisterAuthenticator")) : msgs;
}

/** Step 2: the Scoped window on the owner account. */
export function windowMsg(o: { owner: string; escrow: Hex; maxTickets: number; limits: MandateLimits }): CosmosMsg {
  return openEvmWindowMsg({
    sender: o.owner,
    blocks: o.limits.windowBlocks,
    maxTxs: o.maxTickets,
    maxValue: o.limits.windowMaxValue.toString(),
    allowedTargets: [o.escrow],
  });
}

/** Step 3: the on-chain mandate (D-15), with `maxTickets` = used + mandate.maxTickets (D-29). */
export function onchainMandate(m: Mandate, o: { merchant: Hex; used: number; uqorPerUsd: bigint; mandateHash: Hex }): OnchainMandate {
  return {
    merchant: o.merchant,
    maxFareWei: usdToUqor(m.maxFareUsd, o.uqorPerUsd) * WEI_PER_UQOR,
    maxTickets: o.used + m.maxTickets,
    expiresAt: BigInt(Math.floor(Date.parse(m.expiresAt) / 1000)),
    origin: m.origin.code,
    destination: m.destination.code,
    departFrom: unixDay(m.departFrom),
    departTo: unixDay(m.departTo),
    cabin: CABINS[m.cabin],
    refundableOnly: m.refundableOnly,
    mandateHash: o.mandateHash,
  };
}

export function setMandateData(agent: Hex, mandate: OnchainMandate): Hex {
  return encodeSetMandate(agent, mandate);
}

/**
 * Tickets the agent holds against its quota (D-29): the bookings it made since the deploy block,
 * minus those later `Refunded`. A book() sent as an EVM tx leaves a `Booked` log. One sent as a
 * MsgExecuteEVM through the linked agent key leaves none that eth_getLogs returns, so on that
 * lane `executor` (the qor1 account book() runs as) has its executed calls read and decoded too.
 * Throws when either history cannot be read; callers never guess.
 */
export async function countUsedTickets(chain: ServerChain, escrow: Hex, fromBlock: bigint, agent: Hex, executor?: string): Promise<number> {
  const booked = await chain.getLogs({ address: escrow, fromBlock, topics: [EVENT_TOPICS.Booked, null, pad(agent.toLowerCase() as Hex, { size: 32 })] });
  const held = new Set(booked.map((l) => l.topics[1]?.toLowerCase()));
  if (executor) {
    for (const call of await chain.executedEvmCalls(executor)) {
      if (call.height < fromBlock || call.to.toLowerCase() !== escrow.toLowerCase() || !call.data.startsWith(SELECTORS.book)) continue;
      held.add(bookingIdOfBook(call.data).toLowerCase());
    }
  }
  if (held.size === 0) return 0;
  const refunded = await chain.getLogs({ address: escrow, fromBlock, topics: [EVENT_TOPICS.Refunded] });
  for (const l of refunded) held.delete(l.topics[1]?.toLowerCase());
  return held.size;
}
