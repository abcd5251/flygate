import "server-only";
import { decodeErrorResult } from "viem";
import type { FareCapCheck } from "@/lib/chain";
import { encodeBook, FLIGHT_ESCROW_ABI, type Domain, type Quote } from "@/lib/escrow";
import type { Hex, ServerChain } from "./chain";
import type { LiveKeys } from "./keys";
import { readMandate } from "./mandate";
import { formatQor, WEI_PER_UQOR } from "./money";
import { errorText } from "./tx";

/** What the fare-cap check needs of a quoted booking (the merchant-signed US$428 quote). */
export interface FareCapBooking {
  quote: Quote;
  signature: Hex;
  domain: Domain;
}

export interface FareCapDeps {
  chain: ServerChain;
  keys(): Promise<LiveKeys>;
}

/** "4000000000000000000 wei (4 QOR)". */
const weiText = (wei: bigint) => `${wei} wei (${formatQor(wei / WEI_PER_UQOR)})`;

/**
 * Fare jumps in Live mode (D-17): after the off-chain gate refused the quote, show that the
 * contract refuses it too, without spending anything. book() is simulated with eth_call (the
 * signed quote, from FlyGate's agent) and must answer `FareOverCap(maxFareWei, priceWei)`. The
 * owner's budget in FlightEscrow is read before and after. Nothing is signed or broadcast, so
 * this is a "Live read" without a hash.
 */
export async function fareCapCheck({ chain, keys }: FareCapDeps, b: FareCapBooking): Promise<FareCapCheck> {
  const failed = (code: string, detail: string): FareCapCheck => ({ source: "live", ok: false, code, detail });
  try {
    const agent = (await keys()).roles.agent.signer.address;
    const budgetOf = async () => (await readMandate(chain, b.domain.escrow, b.quote.owner, agent)).budgetWei / WEI_PER_UQOR;
    const before = await budgetOf();
    const r = await chain.ethCall({ to: b.domain.escrow, data: encodeBook(b.quote, b.signature), from: agent });
    const after = await budgetOf();

    const balance = before === after ? `Budget unchanged: ${formatQor(after)}` : `Budget changed: ${formatQor(before)} → ${formatQor(after)}`;
    if (r.status === "success") return failed("not rejected", `book() eth_call did not revert: the contract would accept this quote · ${balance}`);

    let error: { errorName: string; args?: readonly unknown[] } | undefined;
    try {
      error = decodeErrorResult({ abi: FLIGHT_ESCROW_ABI, data: r.data });
    } catch {
      error = undefined;
    }
    if (error?.errorName !== "FareOverCap") {
      const why = error ? `${error.errorName}(${(error.args ?? []).join(", ")})` : r.reason;
      return failed("unexpected revert", `book() eth_call reverted with ${why}, not FareOverCap · ${balance}`);
    }
    const [maxFareWei, priceWei] = error.args as readonly [bigint, bigint];
    const readResult = `book() eth_call → FareOverCap(maxFareWei ${weiText(maxFareWei)}, priceWei ${weiText(priceWei)}) · ${balance}`;
    if (before !== after) return { source: "live", ok: false, code: "balance changed", readResult, detail: readResult };
    return { source: "live", ok: true, readResult, detail: `${readResult} · eth_call on diana, nothing sent` };
  } catch (err) {
    return failed("rpc error", `Fare-cap eth_call failed: ${errorText(err)}`);
  }
}
