export type Cabin = "economy" | "premium" | "business";

export type Place = {
  code: string;
  city: string;
  airportName: string;
  airports: string[];
};

/** What the user authorizes the agent to do. Every field becomes an on-chain or gate rule. */
export type Mandate = {
  origin: Place;
  destination: Place;
  departFrom: string; // YYYY-MM-DD
  departTo: string; // YYYY-MM-DD
  cabin: Cabin;
  refundableOnly: boolean;
  directOnly: boolean;
  maxFareUsd: number;
  maxTickets: number;
  passengers: number;
  expiresAt: string; // ISO with offset
};

export type PassengerInput = {
  surname: string;
  givenName: string;
  passportNo: string;
  nationality: string;
};

export type EncryptedPassenger = {
  displayName: string;
  passportMasked: string;
  kemCiphertextBytes: number;
  aesCiphertextBytes: number;
  preview: string;
};

export type Offer = {
  id: string;
  carrier: string;
  carrierCode: string;
  flightNo: string;
  color: string;
  date: string; // YYYY-MM-DD
  depart: string; // HH:mm
  arrive: string;
  from: string;
  fromTerminal: string;
  to: string;
  toTerminal: string;
  durationMin: number;
  stops: number;
  via?: string;
  cabin: Cabin;
  refundable: boolean;
  baggage: string;
  priceUsd: number;
  testAirline?: boolean;
};

export type RuleKey = "fare" | "refund" | "cabin" | "date" | "route" | "direct";

export type RuleCheck = {
  key: RuleKey;
  label: string;
  ok: boolean;
  detail: string;
};

export type GateVerdict = {
  offerId: string;
  ok: boolean;
  checks: RuleCheck[];
  firstFail?: RuleCheck;
};

export type TxKind = "owner" | "agent" | "merchant" | "contract" | "attacker";

/** Where a chain result came from: a simulated stand-in, or the diana testnet. */
export type TxSource = "simulated" | "live";

/** Which transaction format carried a live tx: a Cosmos tx (Cosmos hash) or a plain EVM tx (0x hash). */
export type TxLane = "cosmos" | "evm";

export type ChainTx = {
  id: string;
  label: string;
  msg: string;
  hash: string;
  kind: TxKind;
  ok: boolean;
  code?: string;
  /** Why a live tx failed (or was refused before sending), for the presenter. */
  reason?: string;
  at: number;
  source: TxSource;
  explorerUrl?: string;
  lane?: TxLane;
};

export type SignedMandate = {
  hash: string;
  sigBytes: number;
  pkBytes: number;
  sigPreview: string;
  signMs: number;
  signedAt: number;
  agentAddress: string;
  /** The mode it was signed in: a simulated mandate never drives live txs (D-25). */
  mode: DemoMode;
};

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export type BookingStepKey =
  | "quote"
  | "verify"
  | "rules"
  | "lock"
  | "order"
  | "ticket"
  | "proof"
  | "release"
  | "refund";

export type BookingStep = {
  key: BookingStepKey;
  status: StepStatus;
  detail?: string;
  hash?: string;
  at?: number;
  source?: TxSource;
  explorerUrl?: string;
  /** Result of a read-only chain query (eth_call / REST), shown as "Live read". */
  readResult?: string;
};

export type BookingStatus = "running" | "succeeded" | "refunded" | "blocked";

export type Booking = {
  offerId: string;
  priceUsd: number;
  quotedPriceUsd?: number;
  steps: BookingStep[];
  status: BookingStatus;
  pnr?: string;
  quoteSigPreview?: string;
  proofSigPreview?: string;
  scenario: Scenario;
};

export type FeedItem = {
  id: string;
  at: number;
  who: "agent" | "gate" | "merchant" | "chain";
  text: string;
  tone?: "info" | "pass" | "block" | "pick";
};

export type AgentPhase =
  | "idle"
  | "parsing"
  | "querying"
  | "checking"
  | "ranking"
  | "countdown"
  | "paused"
  | "handoff";

export type AgentRun = {
  phase: AgentPhase;
  feed: FeedItem[];
  shownOffers: number;
  checkedOffers: number;
  pickId?: string;
  pickReason?: string;
  countdown?: number;
};

export type AttackKey = "overspend" | "drain" | "replay" | "expired" | "qday" | "revoked";

export type AttackState = "idle" | "running" | "blocked";

export type Scenario = "normal" | "price_change" | "order_fail";

/** Whether on-chain steps are simulated in the browser or sent to diana by the server. */
export type DemoMode = "simulated" | "live";

/** Public addresses the Live server signs with (D-27). Never key material. */
export type LiveAddresses = {
  owner: { account: { cosmos: string; evm: string }; signer: string };
  agent: { account: { cosmos: string; evm: string }; signer: string };
  merchant: { account: { cosmos: string; evm: string } };
};
