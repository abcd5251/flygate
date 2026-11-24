import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import {
  bytesToHex,
  concat,
  encodeAbiParameters,
  hexToBytes,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToBytes,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

/**
 * Shared FlightEscrow encoding: the exact bytes contracts/FlightEscrow.sol verifies, and
 * ML-DSA-87 signing over them. Used by the e2e script, the Foundry ffi tests and, later, the
 * frontend. The message format here is the on-chain one; it is unrelated to the demo signing
 * format in pq.ts.
 *
 * message = "qorechain-msg-v1|qorechain-diana|0x"
 *         + lowercase hex(keccak256(abi.encode(TYPE_TAG, chainId, escrow, struct)))
 */

export const DIANA_CHAIN_ID = BigInt(9800);
export const MESSAGE_PREFIX = "qorechain-msg-v1|qorechain-diana|0x";
export const ML_DSA_87_PUBKEY_BYTES = 2592;
export const ML_DSA_87_SIGNATURE_BYTES = 4627;

export const TYPE_TAGS = {
  QUOTE: keccak256(stringToBytes("QUOTE")),
  TICKET: keccak256(stringToBytes("TICKET")),
  CANCEL: keccak256(stringToBytes("CANCEL")),
} as const;
export type TypeTag = keyof typeof TYPE_TAGS;

/** Mirrors FlightEscrow.Cabin; the numeric value is what gets ABI-encoded. */
export const Cabin = { Economy: 0, PremiumEconomy: 1, Business: 2, First: 3 } as const;
export type Cabin = (typeof Cabin)[keyof typeof Cabin];

/** A 3-letter city code ("TPE"), encoded as bytes3. */
export type CityCode = string;

export type Quote = {
  merchant: Address;
  agent: Address;
  offerId: Hex; // bytes32
  priceWei: bigint;
  origin: CityCode;
  destination: CityCode;
  departDay: number; // unix day (uint32)
  cabin: Cabin;
  refundable: boolean;
  expiresAt: bigint; // unix seconds (uint64)
  ticketWindow: number; // seconds (uint32)
};

/** Mirrors FlightEscrow.Mandate: what `setMandate(agent, mandate)` stores for an agent. */
export type OnchainMandate = {
  merchant: Address;
  maxFareWei: bigint;
  maxTickets: number; // uint32
  expiresAt: bigint; // unix seconds (uint64)
  origin: CityCode;
  destination: CityCode;
  departFrom: number; // unix day (uint32), inclusive
  departTo: number; // unix day (uint32), inclusive
  cabin: Cabin;
  refundableOnly: boolean;
  mandateHash: Hex; // bytes32
};

export type TicketProof = {
  bookingId: Hex;
  pnrHash: Hex;
  issuedAt: bigint; // unix seconds (uint64)
};

export type CancelProof = {
  bookingId: Hex;
  reasonCode: number; // uint8
};

const quoteAbi = [
  {
    type: "tuple",
    components: [
      { name: "merchant", type: "address" },
      { name: "agent", type: "address" },
      { name: "offerId", type: "bytes32" },
      { name: "priceWei", type: "uint256" },
      { name: "origin", type: "bytes3" },
      { name: "destination", type: "bytes3" },
      { name: "departDay", type: "uint32" },
      { name: "cabin", type: "uint8" },
      { name: "refundable", type: "bool" },
      { name: "expiresAt", type: "uint64" },
      { name: "ticketWindow", type: "uint32" },
    ],
  },
] as const;

const ticketAbi = [
  {
    type: "tuple",
    components: [
      { name: "bookingId", type: "bytes32" },
      { name: "pnrHash", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
    ],
  },
] as const;

const cancelAbi = [
  {
    type: "tuple",
    components: [
      { name: "bookingId", type: "bytes32" },
      { name: "reasonCode", type: "uint8" },
    ],
  },
] as const;

const QUOTE_TUPLE = "(address merchant, address agent, bytes32 offerId, uint256 priceWei, bytes3 origin, bytes3 destination, uint32 departDay, uint8 cabin, bool refundable, uint64 expiresAt, uint32 ticketWindow)";
const MANDATE_TUPLE = "(address merchant, uint256 maxFareWei, uint32 maxTickets, uint64 expiresAt, bytes3 origin, bytes3 destination, uint32 departFrom, uint32 departTo, uint8 cabin, bool refundableOnly, bytes32 mandateHash)";

/** The FlightEscrow functions, events and errors the Live lane calls, reads or decodes. */
export const FLIGHT_ESCROW_ABI = parseAbi([
  `function setMandate(address agent, ${MANDATE_TUPLE} mandate)`,
  "function revokeMandate(address agent)",
  `function book(${QUOTE_TUPLE} quote, bytes signature) payable returns (bytes32 bookingId)`,
  "function confirmTicket((bytes32 bookingId, bytes32 pnrHash, uint64 issuedAt) proof, bytes signature)",
  "function cancel((bytes32 bookingId, uint8 reasonCode) proof, bytes signature)",
  "function refund(bytes32 bookingId)",
  "event MandateSet(address indexed owner, address indexed agent, address indexed merchant, bytes32 mandateHash)",
  "event Booked(bytes32 indexed bookingId, address indexed agent, address indexed merchant, uint256 priceWei, uint64 deadline)",
  "event Released(bytes32 indexed bookingId, bytes32 pnrHash)",
  "event Refunded(bytes32 indexed bookingId, uint8 reason)",
  "error WrongChain(uint256 chainId)",
  "error NotMandateOwner()",
  "error NoMandate()",
  "error MerchantMismatch()",
  "error AgentMismatch()",
  "error WrongPayment(uint256 expected, uint256 actual)",
  "error BookingExists(bytes32 bookingId)",
  "error NotLocked(bytes32 bookingId)",
  "error TicketDeadlinePassed(bytes32 bookingId)",
  "error MerchantKeyNotRegistered(address merchant)",
  "error UnsupportedKeyAlgorithm(uint8 algorithmId)",
  "error MerchantKeyPossessionUnproven(address merchant)",
  "error InvalidSignature()",
  "error TransferFailed()",
  "error TicketDeadlineNotPassed(bytes32 bookingId)",
  "error TicketQuotaExhausted(uint32 maxTickets)",
  "error MandateIsRevoked()",
  "error MandateExpired()",
  "error FareOverCap(uint256 maxFareWei, uint256 priceWei)",
  "error RouteMismatch()",
  "error DepartDayOutOfRange(uint32 departDay)",
  "error CabinMismatch()",
  "error RefundableRequired()",
  "error QuoteExpired()",
  "error InvalidTicketWindow(uint32 ticketWindow)",
]);

/** 4-byte selectors, as `allowedEvmCalls` and the contract's dispatcher see them. */
export const SELECTORS = {
  setMandate: toFunctionSelector(FLIGHT_ESCROW_ABI[0]),
  revokeMandate: toFunctionSelector(FLIGHT_ESCROW_ABI[1]),
  book: toFunctionSelector(FLIGHT_ESCROW_ABI[2]),
  confirmTicket: toFunctionSelector(FLIGHT_ESCROW_ABI[3]),
  cancel: toFunctionSelector(FLIGHT_ESCROW_ABI[4]),
  refund: toFunctionSelector(FLIGHT_ESCROW_ABI[5]),
} as const;

/** Event topic0s, for eth_getLogs. */
export const EVENT_TOPICS = {
  MandateSet: keccak256(stringToBytes("MandateSet(address,address,address,bytes32)")),
  Booked: keccak256(stringToBytes("Booked(bytes32,address,address,uint256,uint64)")),
  Released: keccak256(stringToBytes("Released(bytes32,bytes32)")),
  Refunded: keccak256(stringToBytes("Refunded(bytes32,uint8)")),
} as const;

/** The unix day (timestamp / 1 days) of a YYYY-MM-DD date at UTC midnight. */
export function unixDay(isoDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`not a YYYY-MM-DD date: ${isoDate}`);
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`not a date: ${isoDate}`);
  return ms / 86_400_000;
}

function cityCode(code: CityCode): Hex {
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`city code must be 3 uppercase letters: ${code}`);
  return stringToHex(code, { size: 3 });
}

/** abi.encode(quote), as Solidity encodes a FlightEscrow.Quote. */
export function encodeQuote(q: Quote): Hex {
  return encodeAbiParameters(quoteAbi, [
    { ...q, origin: cityCode(q.origin), destination: cityCode(q.destination) },
  ]);
}

/** Calldata of `setMandate(agent, mandate)`. */
export function encodeSetMandate(agent: Address, m: OnchainMandate): Hex {
  return encodeFunctionData({
    abi: FLIGHT_ESCROW_ABI,
    functionName: "setMandate",
    args: [agent, { ...m, origin: cityCode(m.origin), destination: cityCode(m.destination) }],
  });
}

/** Calldata of `book(quote, signature)`; the call carries `quote.priceWei` as its value. */
export function encodeBook(q: Quote, signature: Hex): Hex {
  return encodeFunctionData({
    abi: FLIGHT_ESCROW_ABI,
    functionName: "book",
    args: [{ ...q, origin: cityCode(q.origin), destination: cityCode(q.destination) }, signature],
  });
}

/** Calldata of `confirmTicket(proof, signature)`. */
export function encodeConfirmTicket(t: TicketProof, signature: Hex): Hex {
  return encodeFunctionData({ abi: FLIGHT_ESCROW_ABI, functionName: "confirmTicket", args: [t, signature] });
}

/** Calldata of `cancel(proof, signature)`. */
export function encodeCancel(c: CancelProof, signature: Hex): Hex {
  return encodeFunctionData({ abi: FLIGHT_ESCROW_ABI, functionName: "cancel", args: [c, signature] });
}

/** The ML-DSA verify precompile FlightEscrow calls (QoreChain `pqcVerify`, 0x…0a01). */
export const PQC_VERIFY_ADDRESS = "0x0000000000000000000000000000000000000a01" as const;
export const PQC_VERIFY_ABI = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);

/** Calldata of `pqcVerify(pubkey, signature, message)`, for an eth_call. */
export function encodePqcVerify(publicKey: Uint8Array | Hex, signature: Hex, message: Uint8Array): Hex {
  const pk = typeof publicKey === "string" ? publicKey : bytesToHex(publicKey);
  return encodeFunctionData({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", args: [pk, signature, bytesToHex(message)] });
}

/** abi.encode(proof), as Solidity encodes a FlightEscrow.TicketProof. */
export function encodeTicketProof(t: TicketProof): Hex {
  return encodeAbiParameters(ticketAbi, [t]);
}

/** abi.encode(proof), as Solidity encodes a FlightEscrow.CancelProof. */
export function encodeCancelProof(c: CancelProof): Hex {
  return encodeAbiParameters(cancelAbi, [c]);
}

/** bookingId = keccak256(abi.encode(quote)); known before the booking tx lands. */
export function bookingId(q: Quote): Hex {
  return keccak256(encodeQuote(q));
}

/** Where a signature is valid: the chain and the FlightEscrow deployment. */
export type Domain = { chainId: bigint; escrow: Address };

/** The exact message bytes the contract hands to pqcVerify (FlightEscrow.signedMessage). */
export function signedMessage(tag: TypeTag, encodedStruct: Hex, domain: Domain): Uint8Array {
  const head = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [TYPE_TAGS[tag], domain.chainId, domain.escrow],
  );
  const digest = keccak256(concat([head, encodedStruct]));
  return stringToBytes(MESSAGE_PREFIX + digest.slice(2));
}

export const quoteMessage = (q: Quote, d: Domain) => signedMessage("QUOTE", encodeQuote(q), d);
export const ticketMessage = (t: TicketProof, d: Domain) =>
  signedMessage("TICKET", encodeTicketProof(t), d);
export const cancelMessage = (c: CancelProof, d: Domain) =>
  signedMessage("CANCEL", encodeCancelProof(c), d);

export type MerchantKeys = { publicKey: Uint8Array; secretKey: Uint8Array };

/** Deterministic ML-DSA-87 keypair from a 32-byte seed. */
export function merchantKeys(seed: Hex | Uint8Array): MerchantKeys {
  const bytes = typeof seed === "string" ? hexToBytes(seed) : seed;
  if (bytes.length !== 32) throw new Error("ML-DSA-87 seed must be 32 bytes");
  return ml_dsa87.keygen(bytes);
}

/**
 * ML-DSA-87 signature over raw message bytes (pqcVerify adds no prefix or hash).
 * Deterministic (no extra entropy), so the same inputs always give the same signature.
 */
export function signMessage(message: Uint8Array, secretKey: Uint8Array): Hex {
  return bytesToHex(ml_dsa87.sign(message, secretKey, { extraEntropy: false }));
}

/** What pqcVerify computes on chain, for local checks. */
export function verifyMessage(publicKey: Hex, signature: Hex, message: Uint8Array): boolean {
  try {
    return ml_dsa87.verify(hexToBytes(signature), message, hexToBytes(publicKey));
  } catch {
    return false;
  }
}

export const signQuote = (q: Quote, d: Domain, keys: MerchantKeys) =>
  signMessage(quoteMessage(q, d), keys.secretKey);
export const signTicketProof = (t: TicketProof, d: Domain, keys: MerchantKeys) =>
  signMessage(ticketMessage(t, d), keys.secretKey);
export const signCancelProof = (c: CancelProof, d: Domain, keys: MerchantKeys) =>
  signMessage(cancelMessage(c, d), keys.secretKey);
