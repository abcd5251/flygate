import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, hexToString, keccak256, stringToBytes, type Hex } from "viem";
import type { CheckoutQuote, QuoteCheck, TicketProofResult } from "@/lib/chain";
import { bookingId, FLIGHT_ESCROW_ABI, PQC_VERIFY_ADDRESS, SELECTORS, unixDay } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import { DEMO_OFFERS } from "@/lib/offers";
import type { ChainTx } from "@/lib/types";
import type { BroadcastOptions, EthCallRequest, EvmTxRequest } from "./chain";
import { readLiveConfig, type Env } from "./config";
import type { FakeChain } from "./fake-chain";
import { handleLiveCheckout } from "./http";
import { BadRequest, createLiveService } from "./service";
import { env, ESCROW, healthyChain, ownerSlot, roles, SESSION_KEY } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");
/** FA 802: TPE -> NRT, economy, refundable, US$389. */
const OFFER = DEMO_OFFERS.find((o) => o.id === "off_fa802")!;
const PNR = "K7Q2XM";
const OTHER_KEY = `0x${"77".repeat(32)}`;

function service(chain: FakeChain, e: Env = env()) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now: () => NOW_MS } });
}
type Svc = ReturnType<typeof service>;

const quoteOf = async (svc: Svc, scenario = "normal", over: Record<string, unknown> = {}) =>
  (await svc.checkout({ step: "quote", offerId: OFFER.id, scenario, mandate: defaultMandate(), owner: (await roles).owner.cosmos, sessionKey: SESSION_KEY, ...over })) as CheckoutQuote & { ok: true; bookingId: Hex };
const verifyOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "verify", bookingId })) as QuoteCheck;
const lockOf = async (svc: Svc, bookingId: string, sessionKey: string = SESSION_KEY) => (await svc.checkout({ step: "lock", bookingId, sessionKey })) as ChainTx;
const proofOf = async (svc: Svc, bookingId: string, sessionKey: string = SESSION_KEY) => (await svc.checkout({ step: "proof", bookingId, pnr: PNR, sessionKey })) as TicketProofResult;

async function ticketed(svc: Svc) {
  const q = await quoteOf(svc);
  assert.equal(q.ok, true, JSON.stringify(q));
  const verify = await verifyOf(svc, q.bookingId);
  const lock = await lockOf(svc, q.bookingId);
  const proof = await proofOf(svc, q.bookingId);
  return { q, verify, lock, proof };
}

type DecodedQuote = { merchant: Hex; agent: Hex; owner: Hex; offerId: Hex; priceWei: bigint; origin: Hex; destination: Hex; departDay: number; cabin: number; refundable: boolean; expiresAt: bigint; ticketWindow: number };
function decodeBook(data: Hex) {
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data });
  assert.equal(d.functionName, "book");
  const [quote, signature] = d.args as unknown as [DecodedQuote, Hex];
  return { quote, signature };
}
const sentTx = (chain: FakeChain, i: number) => chain.broadcasts()[i].args[1] as EvmTxRequest;

// ------------------------------------------------------------------ Ticketed

test("Ticketed: exactly 2 broadcasts, both from FlyGate's agent EOA (book, confirmTicket); release has the proof's hash", async () => {
  const chain = await healthyChain();
  const { q, verify, lock, proof } = await ticketed(service(chain));

  const sent = chain.broadcasts();
  assert.deepEqual(sent.map((c) => [c.method, c.args[0]]), [["sendEvm", "agent"], ["sendEvm", "agent"]]);
  for (const c of sent) assert.equal((c.args[2] as BroadcastOptions).timeoutMs, 30_000);

  // quote: real ML-DSA-87, no tx
  assert.equal(q.sigBytes, 4627);
  assert.equal(q.priceUsd, 389);
  assert.equal(q.priceQor, "3.89");
  assert.equal(q.source, "live");

  // verify: a pqcVerify eth_call that really checks the merchant signature
  const calls = chain.callsTo("ethCall").map((c) => c.args[0] as EthCallRequest).filter((c) => c.to === PQC_VERIFY_ADDRESS);
  assert.equal(calls.length, 1);
  assert.equal(verify.ok, true);
  assert.match(verify.readResult ?? "", /pqcVerify\(merchant key, quote, signature\) → true/);

  assert.equal(lock.ok, true);
  assert.equal(lock.source, "live");
  assert.equal(lock.lane, "evm");
  assert.equal(lock.msg, "FlyGate agent → FlightEscrow.book()");
  assert.match(lock.label, /from your budget/);
  assert.equal(lock.explorerUrl, `https://explore.qore.network/tx/${lock.hash}`);
  assert.equal(proof.proof.ok, true);
  assert.equal(proof.proof.kind, "merchant");
  assert.match(proof.proof.msg, /submitted by agent/);
  assert.equal(proof.sigBytes, 4627);
  assert.equal(proof.release.hash, proof.proof.hash);
  assert.equal(proof.release.msg, "Released · FlightEscrow.confirmTicket()");
});

test("book(): no value (the owner's budget pays), and the quote maps the demo offer with the owner and the agent (D-14, D-15)", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const { q } = await ticketed(service(chain));
  const tx = sentTx(chain, 0);
  assert.equal(tx.to, ESCROW);
  assert.equal(tx.value ?? BigInt(0), BigInt(0), "FlyGate's agent never pays a fare");
  const { quote, signature } = decodeBook(tx.data);

  assert.equal(quote.priceWei, BigInt("3890000000000000000"), "US$389 at 0.01 QOR/US$ = 3.89 QOR");
  assert.equal(hexToString(quote.origin), "TPE");
  assert.equal(hexToString(quote.destination), "TYO", "city code, not the NRT airport");
  assert.equal(quote.departDay, unixDay(OFFER.date));
  assert.equal(quote.cabin, 0);
  assert.equal(quote.refundable, OFFER.refundable);
  assert.equal(quote.offerId, keccak256(stringToBytes("off_fa802")));
  assert.equal(quote.ticketWindow, 600);
  assert.equal(quote.expiresAt, BigInt(NOW_MS / 1000 + 20 * 60));
  assert.equal(quote.merchant.toLowerCase(), r.merchant.account.evm.toLowerCase());
  assert.equal(quote.agent, r.agent.signer.address, "book()'s msg.sender: FlyGate's agent EOA");
  assert.equal(quote.owner, r.owner.evm, "the owner's budget pays and refunds go back to it");
  assert.equal(signature.length, 2 + 4627 * 2);
  assert.equal(q.bookingId, bookingId({ ...quote, cabin: quote.cabin as 0, origin: hexToString(quote.origin), destination: hexToString(quote.destination) }), "bookingId = keccak256(abi.encode(quote))");
});

test("confirmTicket(): the merchant-signed TicketProof for this booking, sent by the agent EOA to the escrow", async () => {
  const chain = await healthyChain();
  const { q } = await ticketed(service(chain));
  const tx = sentTx(chain, 1);
  assert.equal(tx.to, ESCROW);
  assert.equal(tx.value ?? BigInt(0), BigInt(0));
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: tx.data });
  assert.equal(d.functionName, "confirmTicket");
  const [proof] = d.args as unknown as [{ bookingId: Hex; pnrHash: Hex; issuedAt: bigint }, Hex];
  assert.equal(proof.bookingId, q.bookingId);
  assert.equal(proof.pnrHash, keccak256(stringToBytes(PNR)));
  assert.equal(proof.issuedAt, BigInt(NOW_MS / 1000));
});

// ------------------------------------------------------------------ who may make the agent book

test("quote reads the owner's on-chain mandate and only proceeds for the session that set it", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = service(chain);
  const ok = await quoteOf(svc);
  assert.equal(ok.ok, true);
  const read = chain.callsTo("ethCall").map((c) => c.args[0] as EthCallRequest).find((c) => c.data.startsWith(SELECTORS.mandateOf));
  assert.ok(read, "mandateOf was read");
  assert.equal(read.to, ESCROW);
  const { args } = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: read.data });
  assert.deepEqual(args, [r.owner.evm, r.agent.signer.address]);

  const other = (await quoteOf(svc, "normal", { sessionKey: OTHER_KEY })) as unknown as CheckoutQuote & { ok: false };
  assert.equal(other.ok, false);
  assert.equal(other.code, "not your session");
  const edited = (await quoteOf(svc, "normal", { mandate: { ...defaultMandate(), maxFareUsd: 900 } })) as unknown as CheckoutQuote & { ok: false };
  assert.equal(edited.code, "not your session", "rules edited after signing do not match the on-chain hash");
  assert.equal(chain.broadcasts().length, 0);
});

test("quote refuses an owner without a mandate, a closed one, or an expired one", async () => {
  const slot = await ownerSlot();
  const cases: Array<[(c: FakeChain) => void, string]> = [
    [(c) => delete c.state.mandates[slot], "no mandate"],
    [(c) => (c.state.mandates[slot] = { ...c.state.mandates[slot], revoked: true }), "mandate revoked"],
    [(c) => (c.state.mandates[slot] = { ...c.state.mandates[slot], expiresAt: BigInt(NOW_MS / 1000 - 1) }), "mandate expired"],
  ];
  for (const [change, code] of cases) {
    const chain = await healthyChain();
    change(chain);
    const q = (await quoteOf(service(chain))) as unknown as CheckoutQuote & { ok: false };
    assert.equal(q.ok, false);
    assert.equal(q.code, code);
  }
});

test("lock, proof and cancel need the session key the booking was quoted with", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  const lock = await lockOf(svc, q.bookingId, OTHER_KEY);
  assert.equal(lock.ok, false);
  assert.equal(lock.code, "not your session");
  const proof = await proofOf(svc, q.bookingId, OTHER_KEY);
  assert.equal(proof.proof.code, "not your session");
  const cancel = (await svc.checkout({ step: "cancel", bookingId: q.bookingId, sessionKey: OTHER_KEY })) as { tx: ChainTx };
  assert.equal(cancel.tx.code, "not your session");
  assert.equal(chain.broadcasts().length, 0);
  assert.equal((await lockOf(svc, q.bookingId)).ok, true, "the right key still works: refusals are not cached");
});

// ------------------------------------------------------------------ idempotency and failures

test("the same (step, bookingId) twice broadcasts once, also when the calls overlap", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  const [a, b] = await Promise.all([lockOf(svc, q.bookingId), lockOf(svc, q.bookingId)]);
  const c = await lockOf(svc, q.bookingId);
  assert.equal(chain.broadcasts().length, 1);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);

  const p1 = await proofOf(svc, q.bookingId);
  const p2 = await proofOf(svc, q.bookingId);
  assert.equal(chain.broadcasts().length, 2);
  assert.deepEqual(p2, p1);
});

test("two quotes for the same offer in the same second get different bookingIds, so a new booking is not answered from the old one's cache", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const ticketedQuote = await quoteOf(svc, "normal");
  await lockOf(svc, ticketedQuote.bookingId);
  const failsQuote = await quoteOf(svc, "order_fail");
  assert.notEqual(failsQuote.bookingId, ticketedQuote.bookingId);
  await lockOf(svc, failsQuote.bookingId);
  assert.equal(chain.broadcasts().length, 2, "the second booking's book() is sent, not taken from the first one's cache");
  const { quote } = decodeBook(sentTx(chain, 1).data);
  assert.equal(bookingId({ ...quote, cabin: quote.cabin as 0, origin: hexToString(quote.origin), destination: hexToString(quote.destination) }), failsQuote.bookingId);
  assert.equal(quote.expiresAt, BigInt(NOW_MS / 1000 + 20 * 60 + 1), "only expiresAt moved, by one second");
});

test("a failed broadcast is never resent: the repeat gets the failure", async () => {
  const chain = await healthyChain();
  chain.state.outcomes.push({ mode: "failed", code: "evm revert", reason: "InsufficientBudget(1, 2)" });
  const svc = service(chain);
  const q = await quoteOf(svc);
  const first = await lockOf(svc, q.bookingId);
  const again = await lockOf(svc, q.bookingId);
  assert.equal(chain.broadcasts().length, 1);
  assert.equal(first.ok, false);
  assert.equal(first.explorerUrl, undefined, "no explorer link, so no Live tx label");
  assert.match(first.reason ?? "", /InsufficientBudget/);
  assert.deepEqual(again, first);

  const proof = await proofOf(svc, q.bookingId);
  assert.equal(proof.proof.code, "out of order");
  assert.equal(chain.broadcasts().length, 1);
});

test("a timeout returns a failed step", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const q = await quoteOf(svc);
  await lockOf(svc, q.bookingId);
  chain.state.outcomes.push("timeout");
  const proof = await proofOf(svc, q.bookingId);
  assert.equal(proof.proof.ok, false);
  assert.equal(proof.proof.code, "timeout");
  assert.match(proof.proof.reason ?? "", /^timeout/);
  assert.equal(proof.proof.explorerUrl, undefined);
  assert.equal(proof.release.ok, false);
});

test("nothing is sent for an unknown booking or when Live is unavailable", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const unknown = await lockOf(svc, `0x${"12".repeat(32)}`);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown booking");

  const off = await healthyChain();
  off.state.code = {};
  const q = await quoteOf(service(off));
  assert.equal(q.ok, false);
  assert.match((q as unknown as { reason: string }).reason, /not deployed/);
  assert.equal(chain.broadcasts().length + off.broadcasts().length, 0);
});

test("Fare jumps quotes US$428 (4.28 QOR)", async () => {
  const chain = await healthyChain();
  const q = await quoteOf(service(chain), "price_change");
  assert.equal(q.priceUsd, 428);
  assert.equal(q.priceQor, "4.28");
});

// ------------------------------------------------------------------ input and HTTP

test("malformed input is a BadRequest and never reaches the chain", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = service(chain);
  const quote = { step: "quote", offerId: OFFER.id, scenario: "normal", mandate: defaultMandate(), owner: r.owner.cosmos, sessionKey: SESSION_KEY };
  const bad = [
    { step: "pay" },
    { ...quote, offerId: "off_nope" },
    { ...quote, scenario: "free" },
    { ...quote, mandate: {} },
    { ...quote, owner: r.owner.evm },
    { ...quote, sessionKey: undefined },
    { ...quote, sessionKey: "0x12" },
    { step: "lock", bookingId: "0x12", sessionKey: SESSION_KEY },
    { step: "proof", bookingId: `0x${"12".repeat(32)}`, pnr: "a b", sessionKey: SESSION_KEY },
  ];
  for (const input of bad) await assert.rejects(svc.checkout(input), BadRequest, JSON.stringify(input));
  assert.equal(chain.broadcasts().length, 0);
});

test("POST /api/live/checkout: 404 unless LIVE_MODE=on, 400 for bad input, else the step result", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = service(chain);
  const post = (body: unknown) => new Request("http://x/api/live/checkout", { method: "POST", body: JSON.stringify(body) });
  const body = { step: "quote", offerId: OFFER.id, scenario: "normal", mandate: defaultMandate(), owner: r.owner.cosmos, sessionKey: SESSION_KEY };

  assert.equal((await handleLiveCheckout({}, () => svc, post(body))).status, 404);
  assert.equal((await handleLiveCheckout(env(), () => svc, post({ step: "nope" }))).status, 400);
  const res = await handleLiveCheckout(env(), () => svc, post(body));
  assert.equal(res.status, 200);
  const json = (await res.json()) as CheckoutQuote;
  assert.equal(json.ok, true);
  assert.doesNotMatch(JSON.stringify(json), /secretKey|privateKey|mnemonic|sessionKey/i);
});
