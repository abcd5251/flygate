// `pnpm evm:check` - read-only check that diana is ready for FlightEscrow from the EVM side.
// Sends nothing. Exits 1 and lists what is missing when a requirement fails.
//   - EVM chain id is 9800
//   - pqcKeyStatus(merchant account) = registered, ML-DSA-87, possessionProven,
//     and its pubkey equals derivePqcCanonical(merchant)
//   - each account's EVM balance equals its bank balance (same account, two views)
//   - the owner and agent EVM signers hold QOR (they pay gas and fares)
import { derivePqcCanonical, fromBase } from "@qorechain/sdk";
import { balanceOf, makeClient } from "../bootstrap/chain";
import { ROLES, type Role } from "../bootstrap/env";
import { DIANA_EVM_CHAIN_ID, WEI_PER_UQOR } from "../../src/lib/chain";
import { evmBalance, evmChainId, loadEvmSetup, pqcKeyStatusOnEvm } from "./chain";
import { ALGORITHM_ML_DSA_87 } from "./pqcKeyStatus";

/** Roles whose EVM signer sends transactions in the e2e flow. */
const SENDING_ROLES: readonly Role[] = ["owner", "agent"];

const qor = (wei: bigint) => `${fromBase((wei / WEI_PER_UQOR).toString())} QOR`;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function main(): Promise<void> {
  const setup = await loadEvmSetup();
  const url = setup.network.evmRpc;
  const client = makeClient(setup.network);
  const problems: string[] = [];

  const chainId = await evmChainId(url);
  if (chainId !== DIANA_EVM_CHAIN_ID) problems.push(`EVM chain id is ${chainId}, expected ${DIANA_EVM_CHAIN_ID}`);
  console.log(`EVM RPC ${url} (chain id ${chainId})\n`);

  for (const role of ROLES) {
    const { account, signer } = setup.roles[role];
    const accountWei = await evmBalance(url, account.evm);
    const bankUqor = await balanceOf(client, account.cosmos);
    const signerWei = await evmBalance(url, signer.address);
    console.log(`${role}`);
    console.log(`  account ${account.evm}  ${account.cosmos}  ${qor(accountWei)}`);
    console.log(`  signer  ${signer.address}  ${signer.cosmos}  ${qor(signerWei)}`);
    if (accountWei !== bankUqor * WEI_PER_UQOR) {
      problems.push(`${role}: EVM balance of ${account.evm} differs from bank balance of ${account.cosmos}`);
    }
    if (SENDING_ROLES.includes(role) && signerWei === BigInt(0)) {
      problems.push(`${role}: EVM signer ${signer.address} (${signer.cosmos}) has no QOR`);
    }
  }

  const merchant = setup.roles.merchant.account;
  const status = await pqcKeyStatusOnEvm(url, merchant.evm);
  const expected = derivePqcCanonical(merchant.cosmos, setup.mnemonics.merchant).publicKey;
  const pubkeyMatches = sameBytes(status.pubkey, expected);
  console.log(`\npqcKeyStatus(${merchant.evm}) via eth_call on 0x...0A02`);
  console.log(`  registered        ${status.registered}`);
  console.log(`  algorithmId       ${status.algorithmId}`);
  console.log(`  possessionProven  ${status.possessionProven}`);
  console.log(`  pubkey            ${status.pubkey.length} bytes, ${pubkeyMatches ? "matches" : "DOES NOT match"} derivePqcCanonical`);
  if (!status.registered) problems.push("merchant: no ML-DSA-87 key registered");
  if (status.algorithmId !== ALGORITHM_ML_DSA_87) problems.push(`merchant: algorithmId ${status.algorithmId}, expected ${ALGORITHM_ML_DSA_87}`);
  if (!status.possessionProven) problems.push("merchant: key registered without proof of possession");
  if (!pubkeyMatches) problems.push("merchant: on-chain pubkey differs from the one derived from MERCHANT_MNEMONIC");

  if (problems.length > 0) {
    console.log(`\nNot ready:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nReady.");
}

main().catch((err: unknown) => {
  console.error(`\nevm:check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
