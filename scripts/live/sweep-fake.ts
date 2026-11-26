// Test double for `pnpm live:sweep`'s chain interface. Records every read and send in order,
// answers from `state`, and returns a configured outcome per bookingId for refund() sends.
import type { Hex } from "./probe-lib";
import type { EscrowEvent, RefundOutcome, SweepChain } from "./sweep-lib";

export interface FakeSweepState {
  chainId: number;
  /** Code per lowercase address; missing means "0x". */
  code: Record<string, Hex>;
  head: { number: bigint; timestamp: bigint };
  /** Events with the block they were emitted in. */
  events: { block: bigint; event: EscrowEvent }[];
  sender: Hex;
  /** refund() outcome per lowercase bookingId; missing means success. A thrown Error is also allowed. */
  refund: Record<string, RefundOutcome | Error>;
}

export type FakeSweepCall =
  | { method: "evmChainId" | "getCode" | "latestBlock" }
  | { method: "escrowEvents"; from: bigint; to: bigint }
  | { method: "sendRefund"; bookingId: Hex };

export class FakeSweepChain implements SweepChain {
  readonly calls: FakeSweepCall[] = [];
  readonly state: FakeSweepState;
  private nextHash = 1;

  constructor(state: Partial<FakeSweepState> = {}) {
    this.state = {
      chainId: 9800,
      code: {},
      head: { number: BigInt(1_000), timestamp: BigInt(1_800_000_000) },
      events: [],
      sender: "0x00000000000000000000000000000000000000a1",
      refund: {},
      ...state,
    };
  }

  refundsSent(): Hex[] {
    return this.calls.flatMap((c) => (c.method === "sendRefund" ? [c.bookingId] : []));
  }

  async evmChainId() {
    this.calls.push({ method: "evmChainId" });
    return this.state.chainId;
  }
  async getCode(address: Hex) {
    this.calls.push({ method: "getCode" });
    return this.state.code[address.toLowerCase()] ?? "0x";
  }
  async latestBlock() {
    this.calls.push({ method: "latestBlock" });
    return this.state.head;
  }
  async escrowEvents(_address: Hex, from: bigint, to: bigint) {
    this.calls.push({ method: "escrowEvents", from, to });
    return this.state.events.filter((e) => e.block >= from && e.block <= to).map((e) => e.event);
  }
  senderAddress() {
    return this.state.sender;
  }
  async sendRefund(_escrow: Hex, bookingId: Hex): Promise<RefundOutcome> {
    this.calls.push({ method: "sendRefund", bookingId });
    const set = this.state.refund[bookingId.toLowerCase()];
    if (set instanceof Error) throw set;
    if (set) return set;
    const hash = `0x${(this.nextHash++).toString(16).padStart(64, "0")}` as Hex;
    return { kind: "refunded", hash };
  }
}
