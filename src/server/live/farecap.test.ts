import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeErrorResult, type Hex } from "viem";
import type { CheckoutQuote, FareCapCheck, QuoteCheck } from "@/lib/chain";
import { FLIGHT_ESCROW_ABI } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import { DEMO_OFFERS } from "@/lib/offers";
import type { EthCallRequest, EthCallResult } from "./chain";
import { readLiveConfig, type Env } from "./config";
import { defaultEthCall, type FakeChain } from "./fake-chain";
import { createLiveService } from "./service";
import { env, ESCROW, healthyChain, QOR, roles } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");
const OFFER = DEMO_OFFERS.find((o) => o.id === "off_fa802")!;
/** The default mandate's US$400 cap at 0.01 QOR/US$. */
const MAX_FARE_WEI = BigInt(4) * QOR * BigInt(1_000_000_000_000);
const PRICE_428_WEI = BigInt("4280000000000000000");

function service(chain: FakeChain, e: Env = env()) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now: () => NOW_MS } });
}

type BookQuote = { agent: Hex; priceWei: bigint };

/** FlightEscrow's book() as eth_call: WrongPayment first, then FareOverCap (FlightEscrow.sol:202, :270). */
function escrowEthCall(req: EthCallRequest): EthCallResult {
  if (req.to.toLowerCase() !== ESCROW) return defaultEthCall(req);
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: req.data });
  assert.equal(d.functionName, "book");
  const [quote] = d.args as unknown as [BookQuote, Hex];
  const value = req.value ?? BigInt(0);
  if (value !== quote.priceWei) {
    return { status: "reverted", data: encodeErrorResult({ abi: FLIGHT_ESCROW_ABI, errorName: "WrongPayment", args: [quote.priceWei, value] }), reason: "execution reverted" };
  }
  if (quote.priceWei > MAX_FARE_WEI) {
    return { status: "reverted", data: encodeErrorResult({ abi: FLIGHT_ESCROW_ABI, errorName: "FareOverCap", args: [MAX_FARE_WEI, quote.priceWei] }), reason: "execution reverted" };
  }
  return { status: "success", data: "0x" };
}

/** Fare jumps up to the gate: the merchant signs US$428, pqcVerify checks it. */
async function fareJumps(chain: FakeChain, e?: Env) {
  const svc = service(chain, e);
  const q = (await svc.checkout({ step: "quote", offerId: OFFER.id, scenario: "price_change", mandate: defaultMandate() })) as CheckoutQuote & { ok: true; bookingId: Hex };
  assert.equal(q.ok, true);
  assert.equal(q.priceUsd, 428);
  const v = (await svc.checkout({ step: "verify", bookingId: q.bookingId })) as QuoteCheck;
  assert.equal(v.ok, true);
  const mark = chain.calls.length;
  const cap = (await svc.checkout({ step: "farecap", bookingId: q.bookingId })) as FareCapCheck;
  return { svc, q, cap, after: chain.calls.slice(mark) };
}

test("Fare jumps: 0 broadcasts, 1 book() eth_call answering FareOverCap, 1 balance read before and 1 after", async () => {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.ethCall = escrowEthCall;
  const { cap, after } = await fareJumps(chain);

  assert.equal(chain.broadcasts().length, 0, "nothing is ever sent in Fare jumps");
  const bookCalls = chain.callsTo("ethCall").filter((c) => (c.args[0] as EthCallRequest).to.toLowerCase() === ESCROW);
  assert.equal(bookCalls.length, 1);

  // The farecap step itself: balance, eth_call of book(), balance, in that order.
  assert.deepEqual(after.map((c) => c.method), ["bankBalance", "ethCall", "bankBalance"]);
  assert.equal(after[0].args[0], r.owner.account.cosmos);
  assert.equal(after[2].args[0], r.owner.account.cosmos);

  const req = after[1].args[0] as EthCallRequest;
  const [quote] = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: req.data }).args as unknown as [BookQuote, Hex];
  assert.equal(quote.priceWei, PRICE_428_WEI, "the US$428 quote the merchant signed");
  assert.equal(req.value, PRICE_428_WEI, "msg.value equals the price, so WrongPayment does not fire first");
  assert.equal(req.from?.toLowerCase(), r.owner.account.evm.toLowerCase(), "authenticator lane: book() runs from the owner account's 0x address");

  assert.equal(cap.source, "live");
  assert.equal(cap.ok, true);
  assert.equal(cap.tx, undefined, "a Live read, no tx and no hash");
  assert.match(cap.readResult ?? "", /FareOverCap\(maxFareWei 4000000000000000000 wei \(4 QOR\), priceWei 4280000000000000000 wei \(4\.28 QOR\)\)/);
  assert.match(cap.readResult ?? "", /Balance unchanged: 60 QOR/);
});

test("Fare jumps on LIVE_BOOK_LANE=eoa: book() is simulated from the agent's EOA", async () => {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.ethCall = escrowEthCall;
  const { cap, after } = await fareJumps(chain, env({ LIVE_BOOK_LANE: "eoa" }));
  assert.equal(chain.broadcasts().length, 0);
  assert.equal((after[1].args[0] as EthCallRequest).from?.toLowerCase(), r.agent.signer.address.toLowerCase());
  assert.equal(cap.ok, true);
});

test("Fare jumps: a book() that does not revert with FareOverCap is reported, never shown as the cap", async () => {
  const chain = await healthyChain();
  chain.state.ethCall = (req) => (req.to.toLowerCase() === ESCROW ? { status: "success", data: "0x" } : defaultEthCall(req));
  const { cap } = await fareJumps(chain);
  assert.equal(cap.ok, false);
  assert.equal(cap.code, "not rejected");
  assert.equal(cap.readResult, undefined);
  assert.equal(chain.broadcasts().length, 0);

  const chain2 = await healthyChain();
  chain2.state.ethCall = (req) =>
    req.to.toLowerCase() === ESCROW
      ? { status: "reverted", data: encodeErrorResult({ abi: FLIGHT_ESCROW_ABI, errorName: "NoMandate" }), reason: "execution reverted" }
      : defaultEthCall(req);
  const r2 = await fareJumps(chain2);
  assert.equal(r2.cap.ok, false);
  assert.equal(r2.cap.code, "unexpected revert");
  assert.match(r2.cap.detail ?? "", /NoMandate/);
});

test("Fare jumps: an RPC failure is an error result, nothing is sent", async () => {
  const chain = await healthyChain();
  chain.state.ethCall = (req) => {
    if (req.to.toLowerCase() === ESCROW) throw new Error("connection reset");
    return defaultEthCall(req);
  };
  const { cap } = await fareJumps(chain);
  assert.equal(cap.ok, false);
  assert.equal(cap.code, "rpc error");
  assert.match(cap.detail ?? "", /connection reset/);
  assert.equal(chain.broadcasts().length, 0);
});

test("farecap for an unknown booking checks nothing", async () => {
  const chain = await healthyChain();
  const cap = (await service(chain).checkout({ step: "farecap", bookingId: `0x${"ab".repeat(32)}` })) as FareCapCheck;
  assert.equal(cap.ok, false);
  assert.equal(cap.code, "unknown booking");
  assert.equal(chain.callsTo("ethCall").length, 0);
  assert.equal(chain.broadcasts().length, 0);
});
