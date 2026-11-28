import { test } from "node:test";
import assert from "node:assert/strict";
import { qoreAddresses, qorechainRegistry } from "@qorechain/sdk";
import { bytesToHex, decodeFunctionData, keccak256, stringToBytes, type Hex } from "viem";
import type { ClosePlan, MandatePlan, OwnerState, WalletMessage } from "@/lib/chain";
import { Cabin, encodeCloseMandate, EVENT_TOPICS, FLIGHT_ESCROW_ABI, SELECTORS, unixDay } from "@/lib/escrow";
import { canonicalJson, defaultMandate } from "@/lib/mandate";
import type { ChainTx } from "@/lib/types";
import { readLiveConfig, type Env } from "./config";
import type { FakeChain } from "./fake-chain";
import { handleLiveMandate } from "./http";
import { CLOSE_MANDATE_GAS, mandateHashOf, OPEN_MANDATE_GAS, parseOwner, WALLET_TX_TIMEOUT_MS } from "./mandate";
import { BadRequest, createLiveService } from "./service";
import { CONTROL_HASH, defaultMandateHash, env, ESCROW, healthyChain, ownerSlot, QOR, roles, WALLET_TX, WEI_PER_QOR } from "./test-fixtures";

const NOW_MS = Date.parse("2026-12-01T00:00:00Z");
const registry = qorechainRegistry();

function service(chain: FakeChain, e: Env = env()) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now: () => NOW_MS } });
}

async function freshOwnerChain() {
  const chain = await healthyChain();
  delete chain.state.mandates[await ownerSlot()];
  return chain;
}

const prepare = async (chain: FakeChain, over: Record<string, unknown> = {}) => {
  const r = await roles;
  return (await service(chain).mandate({ action: "prepare", mandate: defaultMandate(), owner: r.owner.cosmos, controlHash: CONTROL_HASH, ...over })) as MandatePlan;
};

/** A wallet message decoded with the registry the chain uses. */
function decode(m: WalletMessage) {
  return registry.decode({ typeUrl: m.typeUrl, value: new Uint8Array(Buffer.from(m.value, "base64")) }) as Record<string, unknown>;
}

function openMandateArgs(payload: Uint8Array) {
  const d = decodeFunctionData({ abi: FLIGHT_ESCROW_ABI, data: bytesToHex(payload) });
  assert.equal(d.functionName, "openMandate");
  return d.args as unknown as [Hex, Record<string, unknown>, bigint];
}

// ------------------------------------------------------------------ encoding constants

test("selectors and event topics match FlightEscrow (forge inspect)", () => {
  assert.equal(SELECTORS.book, "0x2f876d8c");
  assert.equal(SELECTORS.openMandate, "0x8c00bc52");
  assert.equal(SELECTORS.revokeMandate, "0xdd8b8857");
  assert.equal(SELECTORS.confirmTicket, "0xb387fa48");
  assert.equal(SELECTORS.cancel, "0x27c1edef");
  assert.equal(SELECTORS.refund, "0x7249fbb6");
  assert.equal(SELECTORS.mandateOf, "0xad941647");
  assert.equal(encodeCloseMandate("0x0000000000000000000000000000000000000001").slice(0, 10), "0x01b7ecfa");
  assert.equal(EVENT_TOPICS.Booked, "0x5771a9475f3715090c816a5a3f36c3e4ee341021e449120f9f9b3633545ff830");
  assert.equal(EVENT_TOPICS.Refunded, "0x193032d8b1ed8d859745ff29f4e02d2d01d4927c8d9018ffc9f828adcccc7ce8");
});

test("an owner's qor1 address and its EVM view are the same 20 bytes", async () => {
  const r = await roles;
  assert.deepEqual(parseOwner(r.owner.cosmos), { cosmos: r.owner.cosmos, evm: r.owner.evm });
  assert.equal(parseOwner(r.owner.cosmos.toUpperCase()).evm, r.owner.evm);
});

test("the mandate hash binds the rules, the owner, the agent and the session key's hash", async () => {
  const r = await roles;
  const base = { mandate: defaultMandate(), owner: r.owner.evm, agent: r.agent.signer.address, controlHash: CONTROL_HASH };
  const h = mandateHashOf(base);
  assert.equal(h, keccak256(stringToBytes(canonicalJson({ v: "flygate-mandate/2", mandate: base.mandate, owner: r.owner.evm.toLowerCase(), agent: r.agent.signer.address.toLowerCase(), controlHash: CONTROL_HASH }))));
  assert.notEqual(mandateHashOf({ ...base, controlHash: keccak256("0x01") }), h);
  assert.notEqual(mandateHashOf({ ...base, mandate: { ...defaultMandate(), maxFareUsd: 401 } }), h);
  assert.notEqual(mandateHashOf({ ...base, owner: r.agent.signer.address }), h);
});

// ------------------------------------------------------------------ prepare

test("prepare, new owner: one wallet tx = MsgSend of the whole deposit to FlightEscrow, then openMandate claiming it", async () => {
  const r = await roles;
  const chain = await freshOwnerChain();
  const plan = await prepare(chain);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(chain.broadcasts().length, 0, "the server sends nothing for the owner");
  assert.equal(plan.request.chainId, "qorechain-diana");
  assert.equal(plan.request.gasLimit, OPEN_MANDATE_GAS);
  assert.deepEqual(plan.owner, { cosmos: r.owner.cosmos, evm: r.owner.evm });
  assert.equal(plan.agent, r.agent.signer.address);
  assert.equal(plan.depositQor, "4"); // US$400 x 1 ticket at 0.01 QOR/US$
  assert.equal(plan.budgetQor, "4");

  const [send, call] = plan.request.messages;
  assert.equal(plan.request.messages.length, 2);
  assert.equal(send.typeUrl, "/cosmos.bank.v1beta1.MsgSend");
  assert.deepEqual(decode(send), { fromAddress: r.owner.cosmos, toAddress: qoreAddresses({ evm: ESCROW }).cosmos, amount: [{ denom: "uqor", amount: (BigInt(4) * QOR).toString() }] });

  assert.equal(call.typeUrl, "/qorechain.crossvm.v1.MsgCrossVMCall");
  const c = decode(call);
  assert.equal(c.sender, r.owner.cosmos);
  assert.equal(c.targetVm, "evm");
  assert.equal(c.sourceVm, "cosmwasm", "ignored by the chain but ValidateBasic needs a VM other than the target");
  assert.equal(String(c.targetContract).toLowerCase(), ESCROW);
  assert.deepEqual(c.funds, [], "the EVM lane refuses funds; the deposit is the MsgSend");
  assert.equal(c.async, false);
  const [agent, m, deposit] = openMandateArgs(c.payload as Uint8Array);
  assert.equal(agent, r.agent.signer.address);
  assert.equal(deposit, BigInt(4) * WEI_PER_QOR, "the deposit openMandate claims is exactly what the MsgSend sent");
  assert.equal(m.merchant, r.merchant.account.evm);
  assert.equal(m.maxFareWei, BigInt(4) * WEI_PER_QOR);
  assert.equal(m.maxTickets, 1);
  assert.equal(m.expiresAt, BigInt(Math.floor(Date.parse(defaultMandate().expiresAt) / 1000)));
  assert.equal(m.origin, "0x545045"); // "TPE"
  assert.equal(m.destination, "0x54594f"); // "TYO"
  assert.equal(m.departFrom, unixDay("2026-12-20"));
  assert.equal(m.departTo, unixDay("2026-12-22"));
  assert.equal(m.cabin, Cabin.Economy);
  assert.equal(m.refundableOnly, true);
  assert.equal(m.mandateHash, plan.mandateHash);
  assert.equal(plan.mandateHash, await defaultMandateHash());
});

test("prepare tops the budget up only to what the mandate can spend; nothing to deposit means no MsgSend", async () => {
  const slot = await ownerSlot();
  const chain = await healthyChain();
  chain.state.mandates[slot] = { ...chain.state.mandates[slot], budgetWei: BigInt(3) * WEI_PER_QOR };
  const plan = await prepare(chain);
  assert.ok(plan.ok);
  assert.equal(plan.depositQor, "1");
  assert.equal(plan.budgetQor, "4");
  assert.equal(openMandateArgs(decode(plan.request.messages[1]).payload as Uint8Array)[2], WEI_PER_QOR);

  const full = await prepare(await healthyChain()); // 10 QOR already held
  assert.ok(full.ok);
  assert.equal(full.depositQor, "0");
  assert.equal(full.budgetQor, "10");
  assert.deepEqual(full.request.messages.map((m) => m.typeUrl), ["/qorechain.crossvm.v1.MsgCrossVMCall"]);
  assert.equal(openMandateArgs(decode(full.request.messages[0]).payload as Uint8Array)[2], BigInt(0));
});

test("prepare: maxTickets counts from the tickets FlightEscrow says are already used (D-29)", async () => {
  const slot = await ownerSlot();
  const chain = await healthyChain();
  chain.state.mandates[slot] = { ...chain.state.mandates[slot], ticketsUsed: 2 };
  const plan = await prepare(chain, { mandate: { ...defaultMandate(), maxTickets: 3 } });
  assert.ok(plan.ok);
  assert.equal(plan.ticketsUsed, 2);
  assert.equal(openMandateArgs(decode(plan.request.messages.at(-1)!).payload as Uint8Array)[1].maxTickets, 5);
});

test("prepare: LIVE_QOR_PER_USD scales the deposit and the fare cap", async () => {
  const chain = await freshOwnerChain();
  const plan = (await service(chain, env({ LIVE_QOR_PER_USD: "0.1" })).mandate({ action: "prepare", mandate: defaultMandate(), owner: (await roles).owner.cosmos, controlHash: CONTROL_HASH })) as MandatePlan;
  assert.ok(plan.ok);
  assert.equal(plan.depositQor, "40");
});

test("prepare refuses an expired mandate, an unreadable chain, and Live being unavailable", async () => {
  const expired = await prepare(await healthyChain(), { mandate: { ...defaultMandate(), expiresAt: "2026-11-30T00:00:00Z" } });
  assert.deepEqual(expired.ok ? undefined : expired.code, "mandate expired");

  const chain = await healthyChain();
  chain.state.fail.ethCall = new Error("rpc down");
  const down = await prepare(chain);
  assert.equal(down.ok ? undefined : down.code, "rpc error");

  const unavailable = (await service(await healthyChain(), env({ FLIGHT_ESCROW_ADDRESS: undefined })).mandate({ action: "prepare", mandate: defaultMandate(), owner: (await roles).owner.cosmos, controlHash: CONTROL_HASH })) as MandatePlan;
  assert.equal(unavailable.ok ? undefined : unavailable.code, "live unavailable");
});

// ------------------------------------------------------------------ confirm

const confirm = async (chain: FakeChain, over: Record<string, unknown> = {}) =>
  (await service(chain).mandate({ action: "confirm", mandate: defaultMandate(), owner: (await roles).owner.cosmos, controlHash: CONTROL_HASH, txHash: WALLET_TX, ...over })) as ChainTx;

test("confirm: the wallet tx landed and FlightEscrow holds this mandate -> a Live tx with an explorer link", async () => {
  const chain = await healthyChain();
  chain.state.cosmosTxs[WALLET_TX] = { hash: WALLET_TX, height: 10, code: 0 };
  const tx = await confirm(chain, { txHash: WALLET_TX.toLowerCase() });
  assert.equal(tx.ok, true);
  assert.equal(tx.kind, "owner");
  assert.equal(tx.source, "live");
  assert.equal(tx.lane, "cosmos");
  assert.equal(tx.hash, WALLET_TX);
  assert.equal(tx.explorerUrl, `https://explore.qore.network/tx/${WALLET_TX}`);
  assert.deepEqual(chain.callsTo("cosmosTx")[0].args, [WALLET_TX, WALLET_TX_TIMEOUT_MS]);
  assert.equal(chain.broadcasts().length, 0);
});

test("confirm: a wallet tx not included in time, or refused by the chain, is a failure without a Live tx label", async () => {
  const missing = await confirm(await healthyChain());
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "timeout");
  assert.equal(missing.explorerUrl, undefined);

  const chain = await healthyChain();
  chain.state.cosmosTxs[WALLET_TX] = { hash: WALLET_TX, height: 10, code: 5, rawLog: "insufficient funds" };
  const refused = await confirm(chain);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "code 5");
  assert.match(refused.reason ?? "", /insufficient funds/);
  assert.equal(refused.explorerUrl, undefined);
});

test("confirm: a landed tx that did not set this mandate (other session, other rules, revoked) is refused", async () => {
  const cases: Array<(c: FakeChain, slot: string) => void> = [
    (c, slot) => delete c.state.mandates[slot],
    (c, slot) => (c.state.mandates[slot] = { ...c.state.mandates[slot], revoked: true }),
    (c, slot) => (c.state.mandates[slot] = { ...c.state.mandates[slot], mandateHash: keccak256("0x99") }),
  ];
  for (const change of cases) {
    const chain = await healthyChain();
    chain.state.cosmosTxs[WALLET_TX] = { hash: WALLET_TX, height: 10, code: 0 };
    change(chain, await ownerSlot());
    const tx = await confirm(chain);
    assert.equal(tx.ok, false);
    assert.equal(tx.code, "mandate mismatch");
  }
});

// ------------------------------------------------------------------ close, state

test("close: one MsgCrossVMCall to closeMandate(agent) for the wallet, with the budget it returns", async () => {
  const r = await roles;
  const plan = (await service(await healthyChain()).mandate({ action: "close", owner: r.owner.cosmos })) as ClosePlan;
  assert.ok(plan.ok);
  assert.equal(plan.refundQor, "10");
  assert.equal(plan.request.gasLimit, CLOSE_MANDATE_GAS);
  assert.equal(plan.request.messages.length, 1);
  const c = decode(plan.request.messages[0]);
  assert.equal(c.sender, r.owner.cosmos);
  assert.equal(bytesToHex(c.payload as Uint8Array), encodeCloseMandate(r.agent.signer.address));

  const none = (await service(await freshOwnerChain()).mandate({ action: "close", owner: r.owner.cosmos })) as ClosePlan;
  assert.equal(none.ok ? undefined : none.code, "no mandate");
});

test("closed: succeeds only once FlightEscrow shows the mandate revoked", async () => {
  const r = await roles;
  const slot = await ownerSlot();
  const chain = await healthyChain();
  chain.state.cosmosTxs[WALLET_TX] = { hash: WALLET_TX, height: 11, code: 0 };
  const open = (await service(chain).mandate({ action: "closed", owner: r.owner.cosmos, txHash: WALLET_TX })) as ChainTx;
  assert.equal(open.ok, false);
  assert.equal(open.code, "still open");
  chain.state.mandates[slot] = { ...chain.state.mandates[slot], revoked: true, budgetWei: BigInt(0) };
  const done = (await service(chain).mandate({ action: "closed", owner: r.owner.cosmos, txHash: WALLET_TX })) as ChainTx;
  assert.equal(done.ok, true);
  assert.equal(done.hash, WALLET_TX);
});

test("state: the owner's balance and mandate as diana reports them", async () => {
  const r = await roles;
  const st = (await service(await healthyChain()).mandate({ action: "state", owner: r.owner.cosmos })) as OwnerState;
  assert.ok(st.ok);
  assert.equal(st.balanceQor, "60");
  assert.deepEqual(st.mandate, { revoked: false, budgetQor: "10", ticketsUsed: 0, maxTickets: 1, mandateHash: await defaultMandateHash(), expiresAt: Math.floor(Date.parse(defaultMandate().expiresAt) / 1000) });
  const none = (await service(await freshOwnerChain()).mandate({ action: "state", owner: r.owner.cosmos })) as OwnerState;
  assert.ok(none.ok);
  assert.equal(none.mandate, undefined);
});

// ------------------------------------------------------------------ input

test("malformed input is a BadRequest and never reaches the chain", async () => {
  const r = await roles;
  const chain = await healthyChain();
  const svc = service(chain);
  const good = { action: "prepare", mandate: defaultMandate(), owner: r.owner.cosmos, controlHash: CONTROL_HASH };
  const bad = [
    { ...good, action: "link" },
    { ...good, action: undefined },
    { ...good, owner: r.owner.evm },
    { ...good, owner: "cosmos1abc" },
    { ...good, controlHash: "0x1234" },
    { ...good, mandate: { ...defaultMandate(), maxFareUsd: -1 } },
    { ...good, mandate: { ...defaultMandate(), maxTickets: 1.5 } },
    { ...good, mandate: { ...defaultMandate(), cabin: "first" } },
    { ...good, mandate: { ...defaultMandate(), origin: { code: "XXX" } } },
    { ...good, mandate: { ...defaultMandate(), expiresAt: "soon" } },
    { ...good, mandate: "everything" },
    { ...good, action: "confirm", txHash: "0xdeadbeef" },
  ];
  for (const input of bad) await assert.rejects(svc.mandate(input), BadRequest, JSON.stringify(input).slice(0, 80));
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

test("/api/live/mandate: 400 for bad input; otherwise the plan as uncached JSON, ignoring unknown fields", async () => {
  const r = await roles;
  const chain = await freshOwnerChain();
  const svc = service(chain);
  const post = (body: string) => handleLiveMandate(env(), () => svc, new Request("http://x/api/live/mandate", { method: "POST", body }));

  assert.equal((await post("not json")).status, 400);
  const bad = await post(JSON.stringify({ action: "prepare", mandate: defaultMandate(), owner: r.owner.cosmos, controlHash: "nope" }));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /controlHash/);

  const res = await post(JSON.stringify({ action: "prepare", mandate: defaultMandate(), owner: r.owner.cosmos, controlHash: CONTROL_HASH, deposit: "999", to: "0xbad" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const plan = (await res.json()) as MandatePlan;
  assert.ok(plan.ok);
  assert.equal(plan.depositQor, "4");
  assert.equal(chain.broadcasts().length, 0);
});
