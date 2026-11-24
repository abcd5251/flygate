import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEvmRole } from "./keys";

// Public Foundry/Hardhat test mnemonic. Expected values come from
// `cast wallet address|private-key --mnemonic ...` (coin 60, index 0).
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

test("EVM signer is the coin-60 key MetaMask and forge derive from the mnemonic", async () => {
  const role = await deriveEvmRole("agent", TEST_MNEMONIC);
  assert.equal(role.signer.address, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(role.signer.privateKey, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
});

test("account is the bootstrap qor1 account, rendered as the hex of its 20 bytes", async () => {
  const role = await deriveEvmRole("merchant", TEST_MNEMONIC);
  // qor1 from the coin-118 derivation; hex from an independent bech32 decode.
  assert.equal(role.account.cosmos, "qor15yk64u7zc9g9k2yr2wmzeva5qgwxps6yjecvvu");
  assert.equal(role.account.evm.toLowerCase(), "0xa12daaf3c2c1505b288353b62cb3b4021c60c344");
});

test("signer's qor1 form is the bech32 of the signer's own 20 bytes", async () => {
  const role = await deriveEvmRole("owner", TEST_MNEMONIC);
  // Independent bech32 decode of this qor1 gives f39fd6e5...b92266.
  assert.equal(role.signer.cosmos, "qor17w0adeg64ky0daxwd2ugyuneellmjgnxhkv37z");
  assert.notEqual(role.signer.cosmos, role.account.cosmos);
});
