import { test } from "node:test";
import assert from "node:assert/strict";
import { evmAuthSignBytesV2 } from "@qorechain/sdk";
import { bytesToHex, decodeFunctionData, hexToString, keccak256, recoverMessageAddress, stringToBytes, type Hex } from "viem";
import type { CheckoutQuote, QuoteCheck, TicketProofResult } from "@/lib/chain";
import { bookingId, FLIGHT_ESCROW_ABI, PQC_VERIFY_ADDRESS, unixDay } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import { DEMO_OFFERS } from "@/lib/offers";
import type { ChainTx } from "@/lib/types";
import type { BroadcastOptions, CosmosMsg, EthCallRequest, EvmTxRequest } from "./chain";
import { BOOK_GAS_LIMIT } from "./checkout";
import { readLiveConfig, type Env } from "./config";
import type { FakeChain } from "./fake-chain";
import { handleLiveCheckout } from "./http";
import { BadRequest, createLiveService } from "./service";
import { env, ESCROW, healthyChain, roles } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");
/** FA 802: TPE -> NRT, economy, refundable, US$389. */
const OFFER = DEMO_OFFERS.find((o) => o.id === "off_fa802")!;
const PNR = "K7Q2XM";

function service(chain: FakeChain, e: Env = env()) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now: () => NOW_MS } });
}
type Svc = ReturnType<typeof service>;

const quoteOf = async (svc: Svc, scenario = "normal") =>
  (await svc.checkout({ step: "quote", offerId: OFFER.id, scenario, mandate: defaultMandate() })) as CheckoutQuote & { ok: true; bookingId: Hex };
const verifyOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "verify", bookingId })) as QuoteCheck;
const lockOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "lock", bookingId })) as ChainTx;
const proofOf = async (svc: Svc, bookingId: string) => (await svc.checkout({ step: "proof", bookingId, pnr: PNR })) as TicketProofResult;

async function ticketed(svc: Svc) {
  const q = await quoteOf(svc);
  assert.equal(q.ok, true);
  const verify = await verifyOf(svc, q.bookingId);
  const lock = await lockOf(svc, q.bookingId);
  const proof = await proofOf(svc, q.bookingId);
  return { q, verify, lock, proof };
}

type ExecMsg = { relayer: string; account: string; scheme: string; pubkey: Uint8Array; signature: Uint8Array; to: string; value: string; data: Uint8Array; gasLimit: bigint; nonce: bigint };
const execMsg = (chain: FakeChain, i = 0) => {
  const msgs = chain.broadcasts()[i].args[1] as CosmosMsg[];
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].typeUrl, "/qorechain.abstractaccount.v1.MsgExecuteEVM");
  return msgs[0].value as ExecMsg;
};

type DecodedQuote = { merchant: Hex; agent: Hex; owner: Hex; offerId: Hex; priceWei: bigint; origin: Hex; destination: Hex; departDay: number; cabin: number; refundable: boolean; expiresAt: bigint; ticketWindow: number };
function decodeBook(data: Hex) {
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data });
  assert.equal(d.functionName, "book");
  const [quote, signature] = d.args as unknown as [DecodedQuote, Hex];
  return { quote, signature };
}

// ------------------------------------------------------------------ Ticketed

test("Ticketed: exactly 2 broadcasts (book via MsgExecuteEVM, confirmTicket via the agent EOA); release has the proof's hash", async () => {
  const chain = await healthyChain();
  const { q, verify, lock, proof } = await ticketed(service(chain));

  const sent = chain.broadcasts();
  assert.deepEqual(sent.map((c) => [c.method, c.args[0]]), [["sendCosmos", "agent"], ["sendEvm", "agent"]]);
  assert.equal((sent[0].args[2] as BroadcastOptions).authenticatorExecutions, true, "book() results must be checked: code 0 can be a failed execution");
  assert.equal((sent[0].args[2] as BroadcastOptions).extraGas, Number(BOOK_GAS_LIMIT), "the tx must provision book()'s signed gas_limit on top of its estimate");
  for (const c of sent) assert.equal((c.args[2] as BroadcastOptions).timeoutMs, 30_000);

  // quote: real ML-DSA-87, no tx
  assert.equal(q.sigBytes, 4627);
  assert.equal(q.priceUsd, 389);
  assert.equal(q.priceQor, "3.89");
  assert.equal(q.source, "live");

  // verify: a pqcVerify eth_call that really checks the merchant signature
  const calls = chain.callsTo("ethCall").map((c) => c.args[0] as EthCallRequest);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, PQC_VERIFY_ADDRESS);
  assert.equal(verify.ok, true);
  assert.equal(verify.source, "live");
  assert.match(verify.readResult ?? "", /pqcVerify\(merchant key, quote, signature\) → true/);

  // lock and proof: Live txs with explorer links
  assert.equal(lock.ok, true);
  assert.equal(lock.source, "live");
  assert.equal(lock.lane, "cosmos");
  assert.equal(lock.msg, "MsgExecuteEVM → FlightEscrow.book()");
  assert.equal(lock.explorerUrl, `https://explore.qore.network/tx/${lock.hash}`);
  assert.equal(proof.proof.ok, true);
  assert.equal(proof.proof.kind, "merchant");
  assert.match(proof.proof.msg, /submitted by agent/);
  assert.equal(proof.proof.lane, "evm");
  assert.equal(proof.sigBytes, 4627);

  assert.equal(proof.release.hash, proof.proof.hash);
  assert.equal(proof.release.explorerUrl, proof.proof.explorerUrl);
  assert.equal(proof.release.msg, "Released · FlightEscrow.confirmTicket()");
  assert.equal(proof.release.source, "live");
});

test("book(): the quote in the MsgExecuteEVM calldata maps the demo offer (D-14, D-15)", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const { q } = await ticketed(service(chain));
  const m = execMsg(chain);
  const { quote, signature } = decodeBook(bytesToHex(m.data));

  assert.equal(quote.priceWei, BigInt("3890000000000000000"), "US$389 at 0.01 QOR/US$ = 3.89 QOR");
  assert.equal(m.value, "3890000000000000000", "msg.value carries the price");
  assert.equal(hexToString(quote.origin), "TPE");
  assert.equal(hexToString(quote.destination), "TYO", "city code, not the NRT airport");
  assert.equal(quote.departDay, unixDay(OFFER.date));
  assert.equal(quote.departDay, Date.UTC(2026, 11, 20) / 86_400_000);
  assert.equal(quote.cabin, 0);
  assert.equal(quote.refundable, OFFER.refundable);
  assert.equal(quote.offerId, keccak256(stringToBytes("off_fa802")));
  assert.equal(quote.ticketWindow, 600);
  assert.equal(quote.expiresAt, BigInt(NOW_MS / 1000 + 20 * 60));
  assert.equal(quote.merchant.toLowerCase(), r.merchant.account.evm.toLowerCase());
  assert.equal(quote.agent.toLowerCase(), r.owner.account.evm.toLowerCase(), "book() runs from the owner account's 0x (ADR-0002)");
  assert.equal(quote.owner.toLowerCase(), r.owner.signer.address.toLowerCase(), "the setMandate sender owns the mandate; refunds go there (D-10)");
  assert.equal(signature.length, 2 + 4627 * 2);

  // The relayer is the agent's qor1; the call acts for the owner account; the server picked the bookingId.
  assert.equal(m.relayer, r.agent.account.cosmos);
  assert.equal(m.account, r.owner.account.cosmos);
  assert.equal(m.scheme, "secp256k1");
  assert.equal(bytesToHex(m.pubkey), r.agent.signer.address.toLowerCase());
  assert.equal(m.to, ESCROW);
  assert.equal(m.gasLimit, BOOK_GAS_LIMIT);
  assert.equal(q.bookingId, bookingId({ ...quote, cabin: quote.cabin as 0, origin: hexToString(quote.origin), destination: hexToString(quote.destination) }), "bookingId = keccak256(abi.encode(quote))");

  // The agent key signed the v2 digest (EIP-191), with the nonce read from the chain.
  const digest = evmAuthSignBytesV2({ chainId: "qorechain-diana", account: m.account, pubkey: m.pubkey, to: m.to, value: m.value, data: m.data, nonce: m.nonce, gasLimit: m.gasLimit });
  const signer = await recoverMessageAddress({ message: { raw: digest }, signature: bytesToHex(m.signature) });
  assert.equal(signer.toLowerCase(), r.agent.signer.address.toLowerCase());
  assert.deepEqual(chain.callsTo("authNonce").map((c) => c.args), [[r.owner.account.cosmos, r.agent.signer.address]]);
});

test("book() signs with the nonce the chain reports", async () => {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.authNonces[`${r.owner.account.cosmos}/${r.agent.signer.address.toLowerCase()}`] = BigInt(7);
  await ticketed(service(chain));
  assert.equal(execMsg(chain).nonce, BigInt(7));
});

test("confirmTicket(): the merchant-signed TicketProof for this booking, sent by the agent EOA to the escrow", async () => {
  const chain = await healthyChain();
  const { q } = await ticketed(service(chain));
  const tx = chain.broadcasts()[1].args[1] as EvmTxRequest;
  assert.equal(tx.to, ESCROW);
  assert.equal(tx.value ?? BigInt(0), BigInt(0));
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: tx.data });
  assert.equal(d.functionName, "confirmTicket");
  const [proof] = d.args as unknown as [{ bookingId: Hex; pnrHash: Hex; issuedAt: bigint }, Hex];
  assert.equal(proof.bookingId, q.bookingId);
  assert.equal(proof.pnrHash, keccak256(stringToBytes(PNR)));
  assert.equal(proof.issuedAt, BigInt(NOW_MS / 1000));
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
  const { quote } = decodeBook(bytesToHex(execMsg(chain, 1).data));
  assert.equal(bookingId({ ...quote, cabin: quote.cabin as 0, origin: hexToString(quote.origin), destination: hexToString(quote.destination) }), failsQuote.bookingId);
  assert.equal(quote.expiresAt, BigInt(NOW_MS / 1000 + 20 * 60 + 1), "only expiresAt moved, by one second");
});

test("a failed broadcast is never resent: the repeat gets the failure", async () => {
  const chain = await healthyChain();
  chain.state.outcomes.push({ mode: "failed", code: "pqc 21", reason: "hybrid_verify_failed" });
  const svc = service(chain);
  const q = await quoteOf(svc);
  const first = await lockOf(svc, q.bookingId);
  const again = await lockOf(svc, q.bookingId);
  assert.equal(chain.broadcasts().length, 1);
  assert.equal(first.ok, false);
  assert.deepEqual(again, first);
});

test("code 0 but a failed authenticator execution: not a Live tx, carries the error code", async () => {
  const chain = await healthyChain();
  chain.state.outcomes.push({ mode: "revert", code: "execution failed", reason: "FareOverCap(1, 2)" });
  const svc = service(chain);
  const q = await quoteOf(svc);
  const lock = await lockOf(svc, q.bookingId);
  assert.equal(lock.ok, false);
  assert.equal(lock.code, "execution failed");
  assert.equal(lock.explorerUrl, undefined, "no explorer link, so no Live tx label");
  assert.match(lock.reason ?? "", /FareOverCap/);

  // The ticket proof is refused without broadcasting.
  const proof = await proofOf(svc, q.bookingId);
  assert.equal(proof.proof.ok, false);
  assert.equal(proof.release.ok, false);
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

test("a refusal before sending is not cached: the step can run once Live is back", async () => {
  const chain = await healthyChain();
  let now = NOW_MS;
  const svc = createLiveService({ chain, config: readLiveConfig(env()), clock: { now: () => now } });
  const q = await quoteOf(svc);
  chain.state.fail.authNonce = new Error("rate limited");
  const refused = await lockOf(svc, q.bookingId);
  assert.equal(refused.code, "rpc error");
  assert.equal(chain.broadcasts().length, 0);
  delete chain.state.fail.authNonce;
  now += 1;
  const lock = await lockOf(svc, q.bookingId);
  assert.equal(lock.ok, true);
  assert.equal(chain.broadcasts().length, 1);
});

test("Fare jumps quotes US$428 (4.28 QOR)", async () => {
  const chain = await healthyChain();
  const q = await quoteOf(service(chain), "price_change");
  assert.equal(q.priceUsd, 428);
  assert.equal(q.priceQor, "4.28");
});

// ------------------------------------------------------------------ lane

test("LIVE_BOOK_LANE=eoa: the agent's EOA sends book() itself, labelled agent EOA, and the quote names it", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = service(chain, env({ LIVE_BOOK_LANE: "eoa" }));
  const { lock } = await ticketed(svc);
  const sent = chain.broadcasts();
  assert.deepEqual(sent.map((c) => [c.method, c.args[0]]), [["sendEvm", "agent"], ["sendEvm", "agent"]]);
  const tx = sent[0].args[1] as EvmTxRequest;
  assert.equal(tx.to, ESCROW);
  assert.equal(tx.value, BigInt("3890000000000000000"));
  assert.equal(decodeBook(tx.data).quote.agent.toLowerCase(), r.agent.signer.address.toLowerCase());
  assert.equal(lock.msg, "agent EOA → FlightEscrow.book()");
  assert.equal(lock.lane, "evm");
  assert.equal(chain.callsTo("authNonce").length, 0);
});

test("LIVE_BOOK_LANE=eoa: setMandate names the agent EOA (book()'s msg.sender)", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = createLiveService({ chain, config: readLiveConfig(env({ LIVE_BOOK_LANE: "eoa" })), clock: { now: () => Date.parse("2026-12-18T00:00:00Z") } });
  for (const step of ["link", "window", "mandate"]) await svc.setupMandate({ step, mandate: defaultMandate(), mandateHash: `0x${"ab".repeat(32)}` });
  const tx = chain.broadcasts()[2].args[1] as EvmTxRequest;
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: tx.data });
  assert.equal((d.args[0] as Hex).toLowerCase(), r.agent.signer.address.toLowerCase());
});

test("an unknown LIVE_BOOK_LANE makes Live unavailable", async () => {
  const chain = await healthyChain();
  const st = await service(chain, env({ LIVE_BOOK_LANE: "relay" })).status();
  assert.equal(st.available, false);
  assert.match(st.reason ?? "", /LIVE_BOOK_LANE/);
});

// ------------------------------------------------------------------ input and HTTP

test("malformed input is a BadRequest and never reaches the chain", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const bad = [
    { step: "pay" },
    { step: "quote", offerId: "off_nope", scenario: "normal", mandate: defaultMandate() },
    { step: "quote", offerId: OFFER.id, scenario: "free", mandate: defaultMandate() },
    { step: "quote", offerId: OFFER.id, scenario: "normal", mandate: {} },
    { step: "lock", bookingId: "0x12" },
    { step: "proof", bookingId: `0x${"12".repeat(32)}`, pnr: "a b" },
  ];
  for (const input of bad) await assert.rejects(svc.checkout(input), BadRequest, JSON.stringify(input));
  assert.equal(chain.broadcasts().length, 0);
});

test("POST /api/live/checkout: 404 unless LIVE_MODE=on, 400 for bad input, else the step result", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const post = (body: unknown) => new Request("http://x/api/live/checkout", { method: "POST", body: JSON.stringify(body) });
  const body = { step: "quote", offerId: OFFER.id, scenario: "normal", mandate: defaultMandate() };

  assert.equal((await handleLiveCheckout({}, () => svc, post(body))).status, 404);
  assert.equal((await handleLiveCheckout(env(), () => svc, post({ step: "nope" }))).status, 400);
  const res = await handleLiveCheckout(env(), () => svc, post(body));
  assert.equal(res.status, 200);
  const json = (await res.json()) as CheckoutQuote;
  assert.equal(json.ok, true);
  const text = JSON.stringify(json);
  assert.doesNotMatch(text, /secretKey|privateKey|mnemonic/i);
});
