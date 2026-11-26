import "server-only";
import type { ChainTx, TxKind } from "@/lib/types";
import type { BroadcastOutcome } from "./chain";

export interface Clock {
  now(): number;
}

/** What a tx shows: its label and the message or call it carried. */
export type TxText = Pick<ChainTx, "label" | "msg">;
type TxFields = Pick<ChainTx, "ok" | "hash"> & Partial<Pick<ChainTx, "code" | "reason" | "lane" | "explorerUrl">>;

/** A step's tx, and whether anything was broadcast for it (only those are kept for idempotency). */
export type StepResult = { broadcast: boolean; tx: ChainTx };

/**
 * Builds the `ChainTx` records the Live service returns. Only a successful broadcast gets an
 * explorer link (and so the "Live tx" label); a failure carries the chain's error code (D-20).
 */
export function txFactory(clock: Clock, explorer: string) {
  let seq = 0;
  function liveTx(kind: TxKind, text: TxText, fields: TxFields): ChainTx {
    seq += 1;
    return { id: `live_${clock.now()}_${seq}`, kind, source: "live", at: clock.now(), ...text, ...fields };
  }
  return {
    liveTx,
    /** A failure found before anything was sent. Callers do not cache it, so it may be tried again. */
    refused(kind: TxKind, text: TxText, code: string, reason: string): StepResult {
      return { broadcast: false, tx: liveTx(kind, text, { ok: false, hash: "", code, reason }) };
    },
    fromOutcome(kind: TxKind, text: TxText, o: BroadcastOutcome): StepResult {
      if (o.status === "success") {
        return { broadcast: true, tx: liveTx(kind, text, { ok: true, hash: o.hash, lane: o.lane, explorerUrl: `${explorer}/tx/${o.hash}` }) };
      }
      return { broadcast: true, tx: liveTx(kind, text, { ok: false, hash: o.hash ?? "", lane: o.lane, code: o.code, reason: `${o.status}: ${o.reason}` }) };
    },
  };
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
