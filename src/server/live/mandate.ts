import "server-only";
import { bech32ToHex, isValidBech32, msg as composers, qoreAddresses, qorechainRegistry } from "@qorechain/sdk";
import { decodeFunctionResult, hexToBytes, keccak256, stringToBytes } from "viem";
import { Cabin as EscrowCabin, encodeCloseMandate, encodeMandateOf, encodeOpenMandate, FLIGHT_ESCROW_ABI, unixDay, type OnchainMandate } from "@/lib/escrow";
import type { WalletMessage } from "@/lib/chain";
import { canonicalJson, PLACES } from "@/lib/mandate";
import type { Cabin, Mandate } from "@/lib/types";
import type { Hex, ServerChain } from "./chain";
import { usdToUqor, WEI_PER_UQOR } from "./money";

/**
 * The owner's side of Live (ADR-0003). The owner signs with their own QoreX wallet; the server
 * never holds an owner key. It builds the messages the wallet signs, and reads back from
 * FlightEscrow what the wallet did. A request that acts for an owner carries the session key
 * the owner's browser generated: its hash is part of the on-chain mandateHash, so only the
 * browser that set the mandate can make the agent book under it.
 */

/** Longest wait for one Live step (D-30). */
export const STEP_TIMEOUT_MS = 30_000;
/** Longest wait for the owner's wallet tx to be included after the wallet returned its hash. */
export const WALLET_TX_TIMEOUT_MS = 60_000;
/**
 * Gas the wallet tx asks for: a bank send plus a MsgCrossVMCall running openMandate. Measured on
 * diana with `pnpm live:e2e-wallet` (it prints the gas used); QoreX accepts 100k to 5M.
 */
export const OPEN_MANDATE_GAS = 1_000_000;
export const CLOSE_MANDATE_GAS = 600_000;

/** A request the server refuses to act on (HTTP 400). Never reaches the chain. */
export class BadRequest extends Error {}

const CABINS: Record<Cabin, EscrowCabin> = { economy: EscrowCabin.Economy, premium: EscrowCabin.PremiumEconomy, business: EscrowCabin.Business };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

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

/** The owner's account: the qor1 address QoreX reports, and the same 20 bytes as EVM sees them. */
export interface OwnerAccount {
  cosmos: string;
  /** msg.sender of the owner's MsgCrossVMCall, and where withdrawals and late refunds go. */
  evm: Hex;
}

export function parseOwner(raw: unknown): OwnerAccount {
  if (typeof raw !== "string" || !isValidBech32(raw, "qor")) throw new BadRequest("owner must be a qor1… address");
  const cosmos = raw.toLowerCase();
  return { cosmos, evm: qoreAddresses({ hex: bech32ToHex(cosmos) }).evm as Hex };
}

/** A 32-byte 0x value from the request (session key or its hash). */
function parseBytes32(raw: unknown, name: string): Hex {
  if (typeof raw !== "string" || !BYTES32_RE.test(raw)) throw new BadRequest(`${name} must be a 32-byte 0x value`);
  return raw.toLowerCase() as Hex;
}

/** The hash the mandate commits to; the browser keeps the session key itself. */
export const parseControlHash = (raw: unknown) => parseBytes32(raw, "controlHash");
export const controlHashOf = (sessionKey: Hex): Hex => keccak256(sessionKey);
export const parseSessionKey = (raw: unknown) => parseBytes32(raw, "sessionKey");

/**
 * The mandate's on-chain hash: the rules, who they bind (owner, agent) and the session key's
 * hash, so the hash names exactly one owner-approved mandate and one browser session.
 */
export function mandateHashOf(o: { mandate: Mandate; owner: Hex; agent: Hex; controlHash: Hex }): Hex {
  const doc = { v: "flygate-mandate/2", mandate: o.mandate, owner: o.owner.toLowerCase(), agent: o.agent.toLowerCase(), controlHash: o.controlHash };
  return keccak256(stringToBytes(canonicalJson(doc)));
}

/** What the owner deposits for a mandate: the fare cap for every ticket it allows, in uqor. */
export function depositForUqor(m: Mandate, uqorPerUsd: bigint): bigint {
  return usdToUqor(m.maxFareUsd, uqorPerUsd) * BigInt(m.maxTickets);
}

/**
 * The on-chain mandate (D-15). `maxTickets` counts from the tickets already used, which the
 * contract keeps across re-sets (D-29).
 */
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

/** FlightEscrow.mandateOf(owner, agent), as the server uses it. */
export interface MandateState {
  exists: boolean;
  revoked: boolean;
  ticketsUsed: number;
  budgetWei: bigint;
  mandateHash: Hex;
  maxFareWei: bigint;
  maxTickets: number;
  expiresAt: bigint;
}

/** Reads FlightEscrow.mandateOf with eth_call. Throws when the read fails; callers never guess. */
export async function readMandate(chain: ServerChain, escrow: Hex, owner: Hex, agent: Hex): Promise<MandateState> {
  const r = await chain.ethCall({ to: escrow, data: encodeMandateOf(owner, agent) });
  if (r.status !== "success") throw new Error(`mandateOf reverted: ${r.reason}`);
  const m = decodeFunctionResult({ abi: FLIGHT_ESCROW_ABI, functionName: "mandateOf", data: r.data });
  return {
    exists: m.exists,
    revoked: m.revoked,
    ticketsUsed: m.ticketsUsed,
    budgetWei: m.budget,
    mandateHash: m.mandate.mandateHash,
    maxFareWei: m.mandate.maxFareWei,
    maxTickets: m.mandate.maxTickets,
    expiresAt: m.mandate.expiresAt,
  };
}

const registry = qorechainRegistry();

/** One message as QoreX's signAndBroadcast takes it: protobuf bytes, base64. */
function walletMessage(m: { typeUrl: string; value: unknown }): WalletMessage {
  return { typeUrl: m.typeUrl, value: Buffer.from(registry.encode(m as Parameters<typeof registry.encode>[0])).toString("base64") };
}

/**
 * A MsgCrossVMCall from the owner's account into FlightEscrow. `sourceVm` is ignored by the chain
 * (it derives the origin lane) but its ValidateBasic wants a VM other than the target.
 */
function escrowCall(owner: string, escrow: Hex, data: Hex): WalletMessage {
  return walletMessage(
    composers.crossvm.crossVmCall({
      sender: owner,
      sourceVm: "cosmwasm",
      targetVm: "evm",
      targetContract: escrow,
      payload: hexToBytes(data),
      // The EVM lane refuses funds here ("send them separately"): the deposit is a MsgSend.
      funds: [],
      async: false,
    }),
  );
}

/**
 * The owner's one wallet tx for a mandate: a bank send of the deposit to FlightEscrow, then
 * openMandate claiming it. Atomic: both land or neither does. No deposit, no send.
 */
export function openMandateMessages(o: { owner: OwnerAccount; escrow: Hex; agent: Hex; mandate: OnchainMandate; depositUqor: bigint }): WalletMessage[] {
  const out: WalletMessage[] = [];
  if (o.depositUqor > BigInt(0)) {
    out.push(
      walletMessage(
        composers.bank.send({
          fromAddress: o.owner.cosmos,
          toAddress: qoreAddresses({ evm: o.escrow }).cosmos,
          amount: [{ denom: "uqor", amount: o.depositUqor.toString() }],
        }),
      ),
    );
  }
  out.push(escrowCall(o.owner.cosmos, o.escrow, encodeOpenMandate(o.agent, o.mandate, o.depositUqor * WEI_PER_UQOR)));
  return out;
}

/** The owner's wallet tx that revokes the agent and returns the whole unspent budget. */
export function closeMandateMessages(o: { owner: OwnerAccount; escrow: Hex; agent: Hex }): WalletMessage[] {
  return [escrowCall(o.owner.cosmos, o.escrow, encodeCloseMandate(o.agent))];
}
