import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, pad, stringToHex, type Hex } from "viem";
import { bookingId, Cabin, encodeBook, EVENT_TOPICS, FLIGHT_ESCROW_ABI, SELECTORS, type Quote } from "@/lib/escrow";
import { defaultMandate } from "@/lib/mandate";
import type { Mandate } from "@/lib/types";
import type { CosmosMsg, EvmLog, EvmTxRequest, ExecutedEvmCall } from "./chain";
import { readLiveConfig, type Env } from "./config";
import type { FakeChain } from "./fake-chain";
import { handleLiveMandate } from "./http";
import { BadRequest, createLiveService } from "./service";
import { DEPLOY_BLOCK, env, ESCROW, healthyChain, MNEMONICS, QOR, roles } from "./test-fixtures";

const HASH = `0x${"ab".repeat(32)}` as Hex;
/** The demo mandate's expiry: 2026-12-19T23:59:00+08:00. */
const EXPIRY_UNIX = Date.parse("2026-12-19T23:59:00+08:00") / 1000;
/** A day before it: far enough for a full window. */
const NOW_MS = (EXPIRY_UNIX - 86_400) * 1000;

function service(chain: FakeChain, e: Env = env(), now = () => NOW_MS) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now } });
}

type Svc = ReturnType<typeof service>;

async function signAll(svc: Svc, mandate: Mandate = defaultMandate(), hash: Hex = HASH) {
  const out = [];
  for (const step of ["link", "window", "mandate"]) out.push(await svc.setupMandate({ step, mandate, mandateHash: hash }));
  return out;
}

const cosmosMsgs = (chain: FakeChain, i: number) => chain.broadcasts()[i].args[1] as CosmosMsg[];
const evmTx = (chain: FakeChain, i: number) => chain.broadcasts()[i].args[1] as EvmTxRequest;
const valueOf = <T>(msgs: CosmosMsg[], suffix: string) => msgs.find((m) => m.typeUrl.endsWith(suffix))?.value as T;

type RulesMsg = { owner: string; rules: Array<{ id: string; perTxLimit: string; dailyLimit: string; enabled: boolean; allowedEvmCalls: string[] }> };
type RegisterMsg = { owner: string; accountAddress: string; scheme: string; pubkey: Uint8Array; permissions: string[]; expiryUnix: string };
type WindowMsg = { sender: string; blocks: string; maxTxs: string; maxValue: string; allowedTargets: string[] };

function decodeSetMandate(tx: EvmTxRequest) {
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: tx.data });
  assert.equal(d.functionName, "setMandate");
  const [agent, mandate] = d.args as unknown as [Hex, { merchant: Hex; maxFareWei: bigint; maxTickets: number; expiresAt: bigint; origin: Hex; destination: Hex; departFrom: number; departTo: number; cabin: number; refundableOnly: boolean; mandateHash: Hex }];
  return { agent, mandate };
}

const idTopic = (id: number | Hex) => (typeof id === "number" ? pad(`0x${id.toString(16)}`, { size: 32 }) : id);
function bookedLog(agent: string, id: number | Hex, block = DEPLOY_BLOCK + BigInt(typeof id === "number" ? id : 1)): EvmLog {
  return {
    address: ESCROW,
    topics: [EVENT_TOPICS.Booked, idTopic(id), pad(agent.toLowerCase() as Hex, { size: 32 }), pad("0x02", { size: 32 })],
    data: "0x",
    blockNumber: block,
    transactionHash: idTopic(id),
  };
}
function refundedLog(id: number | Hex): EvmLog {
  return { ...bookedLog("0x00", id), topics: [EVENT_TOPICS.Refunded, idTopic(id)] };
}

/** A quote the agent booked; `n` keeps each one's bookingId distinct. */
function bookedQuote(agent: Hex, n: number): Quote {
  return {
    merchant: "0x4f9838Cc3A7F73c1aF4910DB99A8f34fc3C7E574",
    agent,
    owner: "0xb73af9e1AC316Eb1B1a160c7866F3D937178F5F0",
    offerId: pad("0x01", { size: 32 }),
    priceWei: BigInt(389) * BigInt(10) ** BigInt(16),
    origin: "TPE",
    destination: "NRT",
    departDay: 20807,
    cabin: Cabin.Economy,
    refundable: true,
    expiresAt: BigInt(1_800_000_000 + n),
    ticketWindow: 600,
  };
}
const setMandateDataOf = (agent: Hex): Hex => `${SELECTORS.setMandate}${agent.slice(2).padStart(64, "0")}` as Hex;
/** A MsgExecuteEVM that ran without an execution failure, as the owner's tx history lists it. */
function executed(data: Hex, o: { to?: Hex; height?: bigint } = {}): ExecutedEvmCall {
  return { hash: "AB".repeat(32), height: o.height ?? DEPLOY_BLOCK + BigInt(10), to: o.to ?? ESCROW, data };
}

// ------------------------------------------------------------------ encoding constants

test("selectors and event topics match FlightEscrow (forge inspect)", () => {
  assert.equal(SELECTORS.book, "0x2f876d8c");
  assert.equal(SELECTORS.setMandate, "0xb34ffb44");
  assert.equal(SELECTORS.revokeMandate, "0xdd8b8857");
  assert.equal(SELECTORS.confirmTicket, "0xb387fa48");
  assert.equal(SELECTORS.cancel, "0x27c1edef");
  assert.equal(SELECTORS.refund, "0x7249fbb6");
  assert.equal(EVENT_TOPICS.Booked, "0x5771a9475f3715090c816a5a3f36c3e4ee341021e449120f9f9b3633545ff830");
  assert.equal(EVENT_TOPICS.Refunded, "0x193032d8b1ed8d859745ff29f4e02d2d01d4927c8d9018ffc9f828adcccc7ce8");
});

// ------------------------------------------------------------------ order and results

test("broadcasts link -> window -> setMandate, all from the owner, each a Live tx with an explorer link", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const [link, window, mandate] = await signAll(service(chain));

  const sent = chain.broadcasts();
  assert.deepEqual(sent.map((c) => [c.method, c.args[0]]), [["sendCosmos", "owner"], ["sendCosmos", "owner"], ["sendEvm", "owner"]]);
  assert.deepEqual(cosmosMsgs(chain, 0).map((m) => m.typeUrl.split(".").pop()), ["MsgUpdateSpendingRules", "MsgRegisterAuthenticator"]);
  assert.deepEqual(cosmosMsgs(chain, 1).map((m) => m.typeUrl.split(".").pop()), ["MsgOpenEVMWindow"]);
  assert.equal(evmTx(chain, 2).to, ESCROW);
  assert.equal(evmTx(chain, 2).value ?? BigInt(0), BigInt(0));
  for (const c of sent) assert.equal((c.args[2] as { timeoutMs: number }).timeoutMs, 30_000);

  for (const [tx, lane] of [[link, "cosmos"], [window, "cosmos"], [mandate, "evm"]] as const) {
    assert.equal(tx.ok, true);
    assert.equal(tx.source, "live");
    assert.equal(tx.lane, lane);
    assert.equal(tx.kind, "owner");
    assert.equal(tx.explorerUrl, `https://explore.qore.network/tx/${tx.hash}`);
    assert.equal(tx.code, undefined);
  }
  assert.match(link.hash, /^[0-9A-F]{64}$/, "Cosmos hash");
  assert.match(mandate.hash, /^0x[0-9a-f]{64}$/, "0x EVM hash");
  assert.equal(mandate.msg, "FlightEscrow.setMandate()");

  // setMandate's agent is the owner account's 0x address (book()'s msg.sender, ADR-0002).
  assert.equal(decodeSetMandate(evmTx(chain, 2)).agent.toLowerCase(), r.owner.account.evm.toLowerCase());

  const body = JSON.stringify([link, window, mandate]).toLowerCase();
  for (const secret of [...Object.values(MNEMONICS), r.owner.signer.privateKey.slice(2), r.agent.signer.privateKey.slice(2)]) {
    assert.ok(!body.includes(secret.toLowerCase()), "response leaks key material");
  }
});

// ------------------------------------------------------------------ link: key and spending rule

test("link: agent ETH address as a secp256k1 key, evm permission, mandate expiry, one rule allowing only book()", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const m = { ...defaultMandate(), maxFareUsd: 389, maxTickets: 2 };
  await service(chain).setupMandate({ step: "link", mandate: m, mandateHash: HASH });

  const msgs = cosmosMsgs(chain, 0);
  const reg = valueOf<RegisterMsg>(msgs, "MsgRegisterAuthenticator");
  assert.equal(reg.owner, r.owner.account.cosmos);
  assert.equal(reg.accountAddress, r.owner.account.cosmos);
  assert.equal(reg.scheme, "secp256k1");
  assert.equal(Buffer.from(reg.pubkey).toString("hex"), r.agent.signer.address.slice(2).toLowerCase());
  assert.deepEqual(reg.permissions, ["evm"]);
  assert.equal(reg.expiryUnix, String(EXPIRY_UNIX));

  const rules = valueOf<RulesMsg>(msgs, "MsgUpdateSpendingRules");
  assert.equal(rules.owner, r.owner.account.cosmos);
  assert.equal(rules.rules.length, 1, "the full rule set, one rule");
  const [rule] = rules.rules;
  assert.equal(rule.enabled, true);
  assert.deepEqual(rule.allowedEvmCalls, [`${ESCROW}/0x2f876d8c`]);
  for (const forbidden of [SELECTORS.setMandate, SELECTORS.revokeMandate]) {
    assert.ok(!rule.allowedEvmCalls.some((c) => c.includes(forbidden.slice(2))), `allows ${forbidden}`);
  }
  // US$389 at 0.01 QOR/US$ = 3.89 QOR = 3,890,000 uqor; daily = per tx x 2 tickets.
  assert.equal(rule.perTxLimit, "3890000");
  assert.equal(rule.dailyLimit, "7780000");
});

test("link: LIVE_QOR_PER_USD scales the limits", async () => {
  const chain = await healthyChain();
  await service(chain, env({ LIVE_QOR_PER_USD: "0.1" })).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  const rule = valueOf<RulesMsg>(cosmosMsgs(chain, 0), "MsgUpdateSpendingRules").rules[0];
  assert.equal(rule.perTxLimit, String(BigInt(40) * QOR));
  assert.equal(rule.dailyLimit, String(BigInt(40) * QOR));
});

test("link: an agent key that is already linked only gets the full spending rules again", async () => {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.linked[r.owner.account.cosmos] = [{ pubkeyHex: r.agent.signer.address.slice(2).toLowerCase(), revoked: false, expiryUnix: EXPIRY_UNIX }];
  const tx = await service(chain).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, true);
  assert.deepEqual(cosmosMsgs(chain, 0).map((m) => m.typeUrl.split(".").pop()), ["MsgUpdateSpendingRules"]);
  assert.equal(tx.msg, "MsgUpdateSpendingRules");
});

// ------------------------------------------------------------------ window

test("window: owner account, FlightEscrow only, maxTxs = tickets, maxValue = (cap + max fee) x tickets, at most 3,600 blocks", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const m = { ...defaultMandate(), maxFareUsd: 389, maxTickets: 2 };
  const svc = service(chain);
  await svc.setupMandate({ step: "link", mandate: m, mandateHash: HASH });
  await svc.setupMandate({ step: "window", mandate: m, mandateHash: HASH });
  const w = valueOf<WindowMsg>(cosmosMsgs(chain, 1), "MsgOpenEVMWindow");
  assert.equal(w.sender, r.owner.account.cosmos);
  assert.deepEqual(w.allowedTargets, [ESCROW]);
  assert.equal(w.maxTxs, "2");
  assert.equal(w.maxValue, String((BigInt(3_890_000) + BigInt(500_000)) * BigInt(2)));
  assert.equal(w.blocks, "3600");
});

test("window: blocks shrink to the blocks left before the mandate expires", async () => {
  const chain = await healthyChain();
  const svc = service(chain, env(), () => (EXPIRY_UNIX - 1_200) * 1000);
  await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  await svc.setupMandate({ step: "window", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(valueOf<WindowMsg>(cosmosMsgs(chain, 1), "MsgOpenEVMWindow").blocks, "1200");
});

test("an expired mandate is refused before anything is sent", async () => {
  const chain = await healthyChain();
  const tx = await service(chain, env(), () => (EXPIRY_UNIX + 5) * 1000).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, false);
  assert.equal(tx.code, "mandate expired");
  assert.equal(chain.broadcasts().length, 0);
});

// ------------------------------------------------------------------ setMandate and the ticket quota

test("setMandate: Demo mandate mapped to the contract's Mandate, maxTickets = used + mandate.maxTickets", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const agent = r.owner.account.evm;
  chain.state.logs = [
    bookedLog(agent, 1),
    bookedLog(agent, 2),
    bookedLog(agent, 3),
    refundedLog(2),
    bookedLog("0x2222222222222222222222222222222222222222", 4),
    bookedLog(agent, 5, DEPLOY_BLOCK - BigInt(1)), // before the deploy block: not FlightEscrow's
  ];
  const [, , tx] = await signAll(service(chain));
  assert.equal(tx.ok, true);

  const { mandate } = decodeSetMandate(evmTx(chain, 2));
  assert.equal(mandate.maxTickets, 2 + 1, "2 used (3 booked, 1 refunded) + 1 ticket");
  assert.equal(mandate.merchant.toLowerCase(), r.merchant.account.evm.toLowerCase());
  assert.equal(mandate.maxFareWei, BigInt(4) * QOR * BigInt(10) ** BigInt(12), "US$400 -> 4 QOR in wei");
  assert.equal(mandate.expiresAt, BigInt(EXPIRY_UNIX));
  assert.equal(mandate.origin, stringToHex("TPE", { size: 3 }));
  assert.equal(mandate.destination, stringToHex("TYO", { size: 3 }));
  assert.equal(mandate.departFrom, Date.UTC(2026, 11, 20) / 86_400_000);
  assert.equal(mandate.departTo, Date.UTC(2026, 11, 22) / 86_400_000);
  assert.equal(mandate.cabin, 0);
  assert.equal(mandate.refundableOnly, true);
  assert.equal(mandate.mandateHash, HASH);

  const logReads = chain.callsTo("getLogs").map((c) => c.args[0] as { address: string; fromBlock: bigint; topics: (string | null)[] });
  assert.ok(logReads.length > 0);
  for (const f of logReads) {
    assert.equal(f.address, ESCROW);
    assert.equal(f.fromBlock, DEPLOY_BLOCK);
  }
  assert.deepEqual(logReads[0].topics, [EVENT_TOPICS.Booked, null, pad(agent.toLowerCase() as Hex, { size: 32 })]);
});

test("first round: no logs means 0 used, so maxTickets = mandate.maxTickets", async () => {
  const chain = await healthyChain();
  await signAll(service(chain), { ...defaultMandate(), maxTickets: 2 });
  assert.equal(decodeSetMandate(evmTx(chain, 2)).mandate.maxTickets, 2);
});

test("bookings made through the linked agent key count: their Booked logs never reach eth_getLogs", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const agent = r.owner.account.evm;
  const q = (n: number) => bookedQuote(agent, n);
  chain.state.executed = {
    [r.owner.account.cosmos]: [
      executed(encodeBook(q(1), "0x01")),
      executed(encodeBook(q(2), "0x01")), // refunded below
      executed(encodeBook(q(3), "0x01")), // its Booked log also reached eth_getLogs: counted once
      executed(encodeBook(q(4), "0x01"), { height: DEPLOY_BLOCK - BigInt(1) }), // before FlightEscrow
      executed(encodeBook(q(5), "0x01"), { to: "0x3333333333333333333333333333333333333333" }), // not FlightEscrow
      executed(setMandateDataOf(agent)), // not book()
    ],
  };
  chain.state.logs = [refundedLog(bookingId(q(2))), bookedLog(agent, bookingId(q(3))), bookedLog(agent, 7)];
  const [, , tx] = await signAll(service(chain));
  assert.equal(tx.ok, true);
  assert.equal(decodeSetMandate(evmTx(chain, 2)).mandate.maxTickets, 3 + 1, "q1, q3 and booking 7 are held; q2 was refunded");
  const reads = chain.callsTo("executedEvmCalls");
  assert.ok(reads.length > 0);
  for (const c of reads) assert.equal(c.args[0], r.owner.account.cosmos, "book() runs as the owner account");
});

test("on the EOA lane every book() is an EVM tx, so the owner's Cosmos history is not read", async () => {
  const chain = await healthyChain();
  await signAll(service(chain, env({ LIVE_BOOK_LANE: "eoa" })));
  assert.equal(chain.callsTo("executedEvmCalls").length, 0);
});

test("when the owner's MsgExecuteEVM history cannot be read, signing fails and nothing is broadcast", async () => {
  const chain = await healthyChain();
  chain.state.fail.executedEvmCalls = new Error("height 5364103 is not available, lowest height is 8790799");
  const tx = await service(chain).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, false);
  assert.equal(tx.code, "ticket count unknown");
  assert.match(tx.reason!, /lowest height/);
  assert.equal(chain.broadcasts().length, 0);
});

test("when the logs cannot be read, signing fails with the reason and nothing is broadcast", async () => {
  const chain = await healthyChain();
  chain.state.fail.getLogs = new Error("EVM RPC eth_getLogs: block range too large (-32005)");
  const tx = await service(chain).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, false);
  assert.equal(tx.source, "live");
  assert.equal(tx.code, "ticket count unknown");
  assert.match(tx.reason!, /block range too large/);
  assert.equal(tx.explorerUrl, undefined);
  assert.equal(chain.broadcasts().length, 0);
});

test("without FLIGHT_ESCROW_DEPLOY_BLOCK the ticket count is unknown: fails, nothing broadcast", async () => {
  const chain = await healthyChain();
  const tx = await service(chain, env({ FLIGHT_ESCROW_DEPLOY_BLOCK: undefined })).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, false);
  assert.equal(tx.code, "ticket count unknown");
  assert.match(tx.reason!, /FLIGHT_ESCROW_DEPLOY_BLOCK/);
  assert.equal(chain.broadcasts().length, 0);
});

test("a refusal before sending is not kept: once the logs read again, the step goes out", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  chain.state.fail.getLogs = new Error("HTTP 502");
  assert.equal((await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH })).ok, false);
  delete chain.state.fail.getLogs;
  assert.equal((await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH })).ok, true);
  assert.equal(chain.broadcasts().length, 1);
});

// ------------------------------------------------------------------ idempotency and failures

test("the same mandate sent twice broadcasts each step once and returns the first result", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const first = await signAll(svc);
  const again = await signAll(svc);
  assert.equal(chain.broadcasts().length, 3);
  assert.deepEqual(again, first);
});

test("concurrent requests for one step (StrictMode, two tabs) broadcast once", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const [a, b] = await Promise.all([
    svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH }),
    svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH }),
  ]);
  assert.equal(chain.broadcasts().length, 1);
  assert.deepEqual(a, b);
});

test("a failed broadcast is not retried: the repeat gets the same failure, and later steps are refused", async () => {
  for (const mode of ["timeout", "failed", "revert"] as const) {
    const chain = await healthyChain();
    chain.state.outcomes = [mode];
    const svc = service(chain);
    const first = await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
    const again = await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
    const next = await svc.setupMandate({ step: "window", mandate: defaultMandate(), mandateHash: HASH });
    assert.equal(chain.broadcasts().length, 1, mode);
    assert.deepEqual(again, first, mode);
    assert.equal(first.ok, false);
    assert.equal(first.source, "live");
    assert.equal(first.explorerUrl, undefined, "a failed tx never gets a Live tx link");
    assert.equal(first.code, { timeout: "timeout", failed: "broadcast failed", revert: "evm revert" }[mode]);
    assert.equal(next.ok, false);
    assert.equal(next.code, "out of order");
  }
});

test("a reverted setMandate returns its code and hash, without an explorer link", async () => {
  const chain = await healthyChain();
  chain.state.outcomes = ["success", "success", { mode: "revert", code: "evm revert", reason: "execution reverted" }];
  const [, , tx] = await signAll(service(chain));
  assert.equal(tx.ok, false);
  assert.equal(tx.code, "evm revert");
  assert.match(tx.reason!, /execution reverted/);
  assert.match(tx.hash, /^0x/);
  assert.equal(tx.explorerUrl, undefined);
});

test("steps out of order are refused without broadcasting", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const w = await svc.setupMandate({ step: "window", mandate: defaultMandate(), mandateHash: HASH });
  const m = await svc.setupMandate({ step: "mandate", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(w.code, "out of order");
  assert.equal(m.code, "out of order");
  assert.equal(chain.broadcasts().length, 0);
});

test("a mandate hash reused with a different mandate is refused", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  await svc.setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  const tx = await svc.setupMandate({ step: "window", mandate: { ...defaultMandate(), maxFareUsd: 4000 }, mandateHash: HASH });
  assert.equal(tx.code, "mandate mismatch");
  assert.equal(chain.broadcasts().length, 1);
});

test("Live unavailable (no FlightEscrow) refuses before sending", async () => {
  const chain = await healthyChain();
  const tx = await service(chain, env({ FLIGHT_ESCROW_ADDRESS: undefined })).setupMandate({ step: "link", mandate: defaultMandate(), mandateHash: HASH });
  assert.equal(tx.ok, false);
  assert.equal(tx.code, "live unavailable");
  assert.match(tx.reason!, /FlightEscrow not deployed/);
  assert.equal(chain.broadcasts().length, 0);
});

test("malformed input is a BadRequest and never reaches the chain", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const good = { step: "link", mandate: defaultMandate(), mandateHash: HASH };
  const bad = [
    { ...good, step: "spending" },
    { ...good, step: "calldata" },
    { ...good, mandateHash: "0x1234" },
    { ...good, mandate: { ...defaultMandate(), maxFareUsd: -1 } },
    { ...good, mandate: { ...defaultMandate(), maxTickets: 1.5 } },
    { ...good, mandate: { ...defaultMandate(), cabin: "first" } },
    { ...good, mandate: { ...defaultMandate(), origin: { code: "XXX" } } },
    { ...good, mandate: { ...defaultMandate(), expiresAt: "soon" } },
    { ...good, mandate: "everything" },
  ];
  for (const input of bad) await assert.rejects(svc.setupMandate(input), BadRequest, JSON.stringify(input).slice(0, 80));
  assert.equal(chain.calls.length, 0);
});

// ------------------------------------------------------------------ route adapter

test("/api/live/mandate answers 404 unless LIVE_MODE=on, without building the service", async () => {
  for (const mode of [undefined, "off"]) {
    let built = false;
    const req = new Request("http://x/api/live/mandate", { method: "POST", body: "{}" });
    const res = await handleLiveMandate(env({ LIVE_MODE: mode }), () => {
      built = true;
      throw new Error("must not be built");
    }, req);
    assert.equal(res.status, 404);
    assert.equal(built, false);
  }
});

test("/api/live/mandate: 400 for bad input, otherwise the step's tx as uncached JSON", async () => {
  const chain = await healthyChain();
  const svc = service(chain);
  const post = (body: string) => handleLiveMandate(env(), () => svc, new Request("http://x/api/live/mandate", { method: "POST", body }));

  assert.equal((await post("not json")).status, 400);
  const bad = await post(JSON.stringify({ step: "link", mandate: defaultMandate(), mandateHash: "nope" }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /mandateHash/);

  const res = await post(JSON.stringify({ step: "link", mandate: defaultMandate(), mandateHash: HASH, calldata: "0xdeadbeef", to: "0xbad" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const tx = (await res.json()) as { ok: boolean; source: string };
  assert.equal(tx.ok, true);
  assert.equal(tx.source, "live");
  assert.equal(chain.broadcasts().length, 1);
});
