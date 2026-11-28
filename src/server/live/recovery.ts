import "server-only";
import { decodeEventLog } from "viem";
import type { BookingStateResult, OnchainTxRef } from "@/lib/chain";
import { bookingIdOfBook, EVENT_TOPICS, FLIGHT_ESCROW_ABI, SELECTORS } from "@/lib/escrow";
import type { EvmLog, Hex, ServerChain } from "./chain";
import { errorText } from "./tx";

/**
 * The booking-state query (#24, D-28): what diana says happened to one booking, derived from the
 * FlightEscrow events that carry its id (`Booked`, `Released`, `Refunded`). A book() sent as a
 * MsgExecuteEVM leaves no `Booked` log that eth_getLogs returns, so on that lane the executor's
 * executed calls stand in for it (no deadline then: it comes from the log). After a page reload
 * the client asks this instead of sending the step again. It only reads: never a broadcast.
 */
export interface BookingStateDeps {
  chain: ServerChain;
  explorer: string;
  /** FLIGHT_ESCROW_DEPLOY_BLOCK: where the escrow's logs start. */
  deployBlock?: bigint;
  /** The qor1 account book() runs as on the authenticator lane; undefined on the EOA lane. */
  executor(): Promise<string | undefined>;
  /** The deployed FlightEscrow when Live is available, else why not. */
  liveEscrow(): Promise<{ escrow: Hex } | { code: string; reason: string }>;
  /**
   * Waits until no broadcast for this booking is still in flight on this server, so a reload
   * during `lock` sees the outcome of the tx already sent rather than "None".
   */
  settle(bookingId: Hex): Promise<void>;
}

export function createBookingState({ chain, explorer, deployBlock, executor, liveEscrow, settle }: BookingStateDeps) {
  const ref = (hash: string): OnchainTxRef => ({ hash, explorerUrl: `${explorer}/tx/${hash}` });

  /** The MsgExecuteEVM tx that booked `id` on the authenticator lane, if any. */
  async function executedBook(escrow: Hex, fromBlock: bigint, id: Hex): Promise<string | undefined> {
    const account = await executor();
    if (!account) return undefined;
    const call = (await chain.executedEvmCalls(account)).find(
      (c) => c.height >= fromBlock && c.to.toLowerCase() === escrow.toLowerCase() && c.data.startsWith(SELECTORS.book) && bookingIdOfBook(c.data).toLowerCase() === id.toLowerCase(),
    );
    return call?.hash;
  }

  return async function bookingState(id: Hex): Promise<BookingStateResult> {
    const live = await liveEscrow();
    if (!("escrow" in live)) return { ok: false, source: "live", code: live.code, reason: live.reason };
    if (deployBlock === undefined) {
      return { ok: false, source: "live", code: "state unknown", reason: "FLIGHT_ESCROW_DEPLOY_BLOCK is not set, so the booking's events cannot be read" };
    }
    await settle(id);
    let logs: EvmLog[];
    let executedHash: string | undefined;
    try {
      // topic1 is the bookingId in all three events; topic0 tells them apart.
      logs = await chain.getLogs({ address: live.escrow, fromBlock: deployBlock, topics: [null, id] });
      if (!logs.some((l) => l.topics[0]?.toLowerCase() === EVENT_TOPICS.Booked.toLowerCase())) {
        executedHash = await executedBook(live.escrow, deployBlock, id);
      }
    } catch (err) {
      return { ok: false, source: "live", code: "rpc error", reason: `Could not read the booking's events: ${errorText(err)}` };
    }
    const find = (topic: Hex) => logs.find((l) => l.topics[0]?.toLowerCase() === topic.toLowerCase());
    const booked = find(EVENT_TOPICS.Booked);
    const released = find(EVENT_TOPICS.Released);
    const refunded = find(EVENT_TOPICS.Refunded);

    const result: BookingStateResult = { ok: true, source: "live", bookingId: id, state: "None" };
    if (booked) {
      result.booked = ref(booked.transactionHash);
      try {
        const ev = decodeEventLog({ abi: FLIGHT_ESCROW_ABI, eventName: "Booked", topics: booked.topics as [Hex, ...Hex[]], data: booked.data });
        result.deadline = Number(ev.args.deadline);
      } catch {
        /* an undecodable Booked log still means Locked; only the deadline is unknown */
      }
    } else if (executedHash) {
      result.booked = ref(executedHash);
    } else {
      return result;
    }
    // The contract moves Locked -> Released or Locked -> Refunded, never both.
    if (refunded) return { ...result, state: "Refunded", refunded: ref(refunded.transactionHash) };
    if (released) return { ...result, state: "Released", released: ref(released.transactionHash) };
    return { ...result, state: "Locked" };
  };
}
