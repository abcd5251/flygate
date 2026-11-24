import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePqcKeyStatus, encodePqcKeyStatusCall, PQC_KEY_STATUS_ADDRESS } from "./pqcKeyStatus";

// Expected bytes come from Foundry's `cast calldata` / `cast abi-encode`.

test("calldata for pqcKeyStatus(address)", () => {
  assert.equal(PQC_KEY_STATUS_ADDRESS, "0x0000000000000000000000000000000000000A02");
  assert.equal(
    encodePqcKeyStatusCall("0x4f9838Cc3A7F73c1aF4910DB99A8f34fc3C7E574"),
    "0x850dfe510000000000000000000000004f9838cc3a7f73c1af4910db99a8f34fc3c7e574",
  );
});

test("rejects an address that is not 20 bytes of hex", () => {
  assert.throws(() => encodePqcKeyStatusCall("0x1234" as `0x${string}`), /20-byte/);
});

test("decodes (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)", () => {
  // cast abi-encode "f(bool,uint8,bytes,bool)" true 1 0xdeadbeef true
  const ret =
    "0x" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000004" +
    "deadbeef00000000000000000000000000000000000000000000000000000000";
  const status = decodePqcKeyStatus(ret);
  assert.equal(status.registered, true);
  assert.equal(status.algorithmId, 1);
  assert.deepEqual(status.pubkey, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(status.possessionProven, true);
});

test("decodes an unregistered account (empty pubkey)", () => {
  // cast abi-encode "f(bool,uint8,bytes,bool)" false 0 0x false
  const ret = "0x" + "0".repeat(64 * 2) + "0".repeat(62) + "80" + "0".repeat(64 * 2);
  assert.deepEqual(decodePqcKeyStatus(ret), {
    registered: false,
    algorithmId: 0,
    pubkey: new Uint8Array(0),
    possessionProven: false,
  });
});

test("rejects a truncated return value", () => {
  assert.throws(() => decodePqcKeyStatus("0x" + "0".repeat(64 * 3)), /pqcKeyStatus/);
});
