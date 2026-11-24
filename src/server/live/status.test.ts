import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePqcCanonical } from "@qorechain/sdk";
import { deriveEvmRole } from "../../../scripts/evm/keys";
import { readLiveConfig, type Env } from "./config";
import { FakeChain } from "./fake-chain";
import { handleLiveStatus } from "./http";
import { createLiveService, STATUS_TTL_MS } from "./service";
import { usdToUqor } from "./money";

// Public test mnemonics (BIP-39 vectors / Foundry default). Never real keys.
const MNEMONICS = {
  OWNER_MNEMONIC: "test test test test test test test test test test test junk",
  AGENT_MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  MERCHANT_MNEMONIC: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
};
const ESCROW = "0x1111111111111111111111111111111111111111";
const QOR = BigInt(1_000_000);

const roles = Promise.all([
  deriveEvmRole("owner", MNEMONICS.OWNER_MNEMONIC),
  deriveEvmRole("agent", MNEMONICS.AGENT_MNEMONIC),
  deriveEvmRole("merchant", MNEMONICS.MERCHANT_MNEMONIC),
]).then(([owner, agent, merchant]) => ({
  owner,
  agent,
  merchant,
  merchantPqc: derivePqcCanonical(merchant.account.cosmos, MNEMONICS.MERCHANT_MNEMONIC),
}));

function env(overrides: Env = {}): Env {
  return { LIVE_MODE: "on", ...MNEMONICS, FLIGHT_ESCROW_ADDRESS: ESCROW, FLIGHT_ESCROW_DEPLOY_BLOCK: "100", ...overrides };
}

/** A diana where everything Live needs is in place. */
async function healthyChain(): Promise<FakeChain> {
  const r = await roles;
  return new FakeChain({
    chainId: 9800,
    code: { [ESCROW]: "0x6080604052" },
    pqc: {
      [r.merchant.account.evm.toLowerCase()]: {
        registered: true,
        algorithmId: 1,
        pubkey: r.merchantPqc.publicKey,
        possessionProven: true,
      },
    },
    bank: { [r.owner.account.cosmos]: BigInt(60) * QOR, [r.agent.account.cosmos]: BigInt(20) * QOR },
    evm: {
      [r.owner.signer.address.toLowerCase()]: BigInt(10) ** BigInt(18),
      [r.agent.signer.address.toLowerCase()]: BigInt(10) ** BigInt(18),
    },
  });
}

function service(chain: FakeChain, e: Env = env(), now = () => 1_000_000) {
  return createLiveService({ chain, config: readLiveConfig(e), clock: { now } });
}

async function statusOf(chain: FakeChain, e?: Env) {
  return service(chain, e).status();
}

test("available when every check passes, with public addresses and the explorer base URL", async () => {
  const r = await roles;
  const status = await statusOf(await healthyChain());
  assert.equal(status.reason, undefined);
  assert.equal(status.available, true);
  assert.equal(status.escrow, ESCROW);
  assert.equal(status.explorer, "https://explore.qore.network");
  assert.equal(status.addresses?.owner.account.cosmos, r.owner.account.cosmos);
  assert.equal(status.addresses?.owner.signer, r.owner.signer.address);
  assert.equal(status.addresses?.merchant.account.evm, r.merchant.account.evm);
});

test("explorer base URL comes from QORE_EXPLORER_URL", async () => {
  const status = await statusOf(await healthyChain(), env({ QORE_EXPLORER_URL: "https://explorer.example/" }));
  assert.equal(status.explorer, "https://explorer.example");
});

test("unavailable when FLIGHT_ESCROW_ADDRESS is missing, without touching the chain", async () => {
  const chain = await healthyChain();
  const status = await statusOf(chain, env({ FLIGHT_ESCROW_ADDRESS: undefined }));
  assert.equal(status.available, false);
  assert.match(status.reason!, /^FlightEscrow not deployed/);
  assert.equal(status.escrow, undefined);
  assert.equal(chain.calls.length, 0);
});

test("unavailable when FLIGHT_ESCROW_ADDRESS is not a 0x address", async () => {
  for (const bad of ["0x1234", "qor1abc", "1111111111111111111111111111111111111111", `${ESCROW}00`]) {
    const status = await statusOf(await healthyChain(), env({ FLIGHT_ESCROW_ADDRESS: bad }));
    assert.equal(status.available, false, bad);
    assert.match(status.reason!, /FLIGHT_ESCROW_ADDRESS is not a valid 0x address/);
  }
});

test("unavailable when the escrow address has no code", async () => {
  for (const empty of ["0x", "0x0", "0x00"] as const) {
    const chain = await healthyChain();
    chain.state.code[ESCROW] = empty;
    const status = await statusOf(chain);
    assert.equal(status.available, false, empty);
    assert.match(status.reason!, /^FlightEscrow not deployed \(no code at 0x1111/);
    assert.equal(status.escrow, undefined, "an undeployed address is never reported as the escrow");
  }
});

test("unavailable on the wrong EVM chain id", async () => {
  const chain = await healthyChain();
  chain.state.chainId = 1;
  const status = await statusOf(chain);
  assert.equal(status.available, false);
  assert.match(status.reason!, /EVM chain id is 1, expected 9800/);
});

test("unavailable when the merchant's on-chain PQC key is missing, wrong or unproven", async () => {
  const r = await roles;
  const key = r.merchant.account.evm.toLowerCase();
  const other = derivePqcCanonical(r.owner.account.cosmos, MNEMONICS.OWNER_MNEMONIC).publicKey;
  const cases = [
    { patch: { registered: false }, reason: /not registered/ },
    { patch: { algorithmId: 2 }, reason: /algorithmId 2, expected 1/ },
    { patch: { possessionProven: false }, reason: /no proof of possession/ },
    { patch: { pubkey: other }, reason: /does not match MERCHANT_MNEMONIC/ },
  ];
  for (const c of cases) {
    const chain = await healthyChain();
    chain.state.pqc[key] = { ...chain.state.pqc[key], ...c.patch };
    const status = await statusOf(chain);
    assert.equal(status.available, false);
    assert.match(status.reason!, c.reason);
  }
});

test("pqcKeyStatus is read for the merchant's bootstrap account, as FlightEscrow does", async () => {
  const r = await roles;
  const chain = await healthyChain();
  await statusOf(chain);
  assert.deepEqual(chain.callsTo("pqcKeyStatus").map((c) => c.args[0]), [r.merchant.account.evm]);
});

test("unavailable when the owner cannot pay one max fare plus fees", async () => {
  const r = await roles;
  // US$400 cap at 0.01 QOR/US$ = 4 QOR; just the fare without fee headroom is not enough.
  assert.equal(usdToUqor(400, BigInt(10_000)), BigInt(4) * QOR);
  const chain = await healthyChain();
  chain.state.bank[r.owner.account.cosmos] = BigInt(4) * QOR;
  const status = await statusOf(chain);
  assert.equal(status.available, false);
  assert.match(status.reason!, /^Owner balance 4 QOR is below one max fare plus fees/);
});

test("LIVE_QOR_PER_USD scales the owner balance requirement", async () => {
  const r = await roles;
  const chain = await healthyChain();
  chain.state.bank[r.owner.account.cosmos] = BigInt(30) * QOR;
  const status = await statusOf(chain, env({ LIVE_QOR_PER_USD: "0.1" })); // US$400 -> 40 QOR
  assert.equal(status.available, false);
  assert.match(status.reason!, /below one max fare plus fees \(41 QOR\)/);
});

test("unavailable when the relayer or a submitting signer has no balance", async () => {
  const r = await roles;
  const cases = [
    { empty: (c: FakeChain) => delete c.state.bank[r.agent.account.cosmos], reason: /^Relayer \(agent account\) has no balance/ },
    { empty: (c: FakeChain) => delete c.state.evm[r.owner.signer.address.toLowerCase()], reason: /^Owner EVM signer has no balance/ },
    { empty: (c: FakeChain) => delete c.state.evm[r.agent.signer.address.toLowerCase()], reason: /^Agent EVM signer has no balance/ },
  ];
  for (const c of cases) {
    const chain = await healthyChain();
    c.empty(chain);
    const status = await statusOf(chain);
    assert.equal(status.available, false);
    assert.match(status.reason!, c.reason);
  }
});

test("unavailable when a mnemonic is missing or invalid, naming only the variable", async () => {
  const chain = await healthyChain();
  const missing = await statusOf(chain, env({ AGENT_MNEMONIC: "", MERCHANT_MNEMONIC: undefined }));
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "Missing AGENT_MNEMONIC, MERCHANT_MNEMONIC (run pnpm bootstrap)");
  assert.equal(missing.addresses, undefined);

  const invalid = await statusOf(chain, env({ OWNER_MNEMONIC: "not a real mnemonic at all" }));
  assert.equal(invalid.reason, "OWNER_MNEMONIC is not a valid BIP-39 mnemonic");
  assert.ok(!JSON.stringify(invalid).includes("not a real mnemonic"));
  assert.equal(chain.calls.length, 0);
});

test("unavailable when LIVE_MODE is not on", async () => {
  const status = await statusOf(await healthyChain(), env({ LIVE_MODE: "off" }));
  assert.equal(status.available, false);
  assert.equal(status.reason, "LIVE_MODE is not on");
});

test("an RPC error makes Live unavailable with the error as the reason", async () => {
  const chain = await healthyChain();
  chain.state.fail.getCode = new Error("EVM RPC eth_getCode: HTTP 502");
  const status = await statusOf(chain);
  assert.equal(status.available, false);
  assert.equal(status.reason, "Chain read failed: EVM RPC eth_getCode: HTTP 502");
});

test("the status result is reused for 30 seconds", async () => {
  const chain = await healthyChain();
  let now = 5_000;
  const svc = service(chain, env(), () => now);
  await svc.status();
  const reads = chain.calls.length;
  now += STATUS_TTL_MS - 1;
  await svc.status();
  assert.equal(chain.calls.length, reads, "no new reads inside the TTL");
  now += 1;
  const fresh = await svc.status();
  assert.equal(chain.calls.length, reads * 2, "re-checked once the TTL is over");
  assert.equal(fresh.checkedAt, now);
});

test("no response ever contains key material", async () => {
  const r = await roles;
  const secrets = [
    ...Object.values(MNEMONICS),
    ...Object.values(MNEMONICS).map((m) => m.split(" ").slice(0, 3).join(" ")),
    r.owner.signer.privateKey.slice(2),
    r.agent.signer.privateKey.slice(2),
    r.merchant.signer.privateKey.slice(2),
    Buffer.from(r.merchantPqc.secretKey.slice(0, 32)).toString("hex"),
  ];
  const lowBalance = await healthyChain();
  lowBalance.state.bank[r.owner.account.cosmos] = BigInt(0);
  const results = [
    await statusOf(await healthyChain()),
    await statusOf(lowBalance),
    await statusOf(await healthyChain(), env({ FLIGHT_ESCROW_ADDRESS: undefined })),
  ];
  for (const status of results) {
    const body = await (await handleLiveStatus(env(), () => ({ status: async () => status }))).text();
    for (const s of secrets) assert.ok(!body.toLowerCase().includes(s.toLowerCase()), "response leaks key material");
    assert.ok(!/privateKey|secretKey/i.test(body));
  }
});

test("/api/live/status answers 404 unless LIVE_MODE=on, without building the service", async () => {
  for (const mode of [undefined, "", "off", "true", "ON "]) {
    let built = false;
    const res = await handleLiveStatus(env({ LIVE_MODE: mode }), () => {
      built = true;
      throw new Error("must not be built");
    });
    assert.equal(res.status, 404, JSON.stringify(mode));
    assert.equal(built, false);
  }
});

test("/api/live/status returns the service status as uncached JSON when LIVE_MODE=on", async () => {
  const svc = service(await healthyChain());
  const res = await handleLiveStatus(env(), () => svc);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { available: boolean; escrow: string };
  assert.equal(body.available, true);
  assert.equal(body.escrow, ESCROW);
});
