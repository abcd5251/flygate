// `pnpm escrow:deploy` - get the owner and agent EVM signers onto diana's EVM lane and
// deploy FlightEscrow. Every step reads the chain first and is skipped when already done;
// rerun after any failure.
//   1. Bank sends (hybrid-signed): owner qor1 -> owner signer, agent qor1 -> agent signer,
//      only the shortfall below what one run needs (SIGNER_NEED_UQOR).
//   2. ML-DSA-87 key with proof of possession for each signer (MsgRegisterPQCKeyV2).
//   3. Owner signer EVM window sized for the CREATE plus one openMandate (MsgOpenEVMWindow).
//   4. `forge script contracts/script/DeployFlightEscrow.s.sol` simulates the deploy from the
//      owner signer; the recorded CREATE is then signed here and broadcast once.
// Writes deployments/diana.json. Never prints keys.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, getContractAddress, type Hex } from "viem";
import { DIANA_EVM_CHAIN_ID } from "../../src/lib/chain";
import { balanceOf, connect, DENOM, deriveRole, formatQor, makeClient } from "../bootstrap/chain";
import type { Role } from "../bootstrap/env";
import { loadEvmSetup, type EvmSetup } from "../evm/chain";
import { GAS_CAP, ownerDeployWindow, SIGNER_NEED_UQOR } from "./budget";
import { topUpAmount, type TopUpRule } from "./plan";
import { readRecord, txRecord, writeRecord, type DeploymentRecord } from "./record";
import { openWindow, registerSigner } from "./signers";
import { makeClients, sendTx, walletFor } from "./tx";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = "contracts/script/DeployFlightEscrow.s.sol";
const DRY_RUN_LOG = resolve(ROOT, `broadcast/DeployFlightEscrow.s.sol/${DIANA_EVM_CHAIN_ID}/dry-run/run-latest.json`);

/**
 * Owner signer: deploy gas, then the e2e openMandate with its deposit.
 * Agent signer: three 1-QOR fares plus gas per e2e run.
 * Topped up only by the shortfall, so a funded signer is never sent more.
 */
const SIGNER_FUNDING: Partial<Record<Role, TopUpRule>> = {
  owner: { min: SIGNER_NEED_UQOR.owner, target: SIGNER_NEED_UQOR.owner },
  agent: { min: SIGNER_NEED_UQOR.agent, target: SIGNER_NEED_UQOR.agent },
};

async function fundSigners(setup: EvmSetup, record: DeploymentRecord): Promise<void> {
  const client = makeClient(setup.network);
  for (const [role, rule] of Object.entries(SIGNER_FUNDING) as [Role, TopUpRule][]) {
    const to = setup.roles[role].signer.cosmos;
    // The balance read is retried; the send is not. A rerun re-reads and skips a landed send.
    const balance = await balanceOf(client, to);
    const amount = topUpAmount(balance, rule);
    if (amount === BigInt(0)) {
      console.log(`${role} signer ${to} holds ${formatQor(balance)}; no funding needed.`);
      continue;
    }
    const from = await deriveRole(role, setup.mnemonics[role]);
    const tx = await connect(client, from);
    try {
      const res = await tx.bankSend(to, [{ denom: DENOM, amount: amount.toString() }]);
      if (res.code !== 0) throw new Error(`Funding ${role} signer failed (code ${res.code}): ${res.rawLog ?? ""}`);
      console.log(`${role} qor1 -> ${role} signer ${formatQor(amount)}: ${res.transactionHash}`);
      record.funding.push({
        label: `${role} account -> ${role} EVM signer`,
        amountUqor: amount.toString(),
        tx: txRecord(setup.network.explorer, { hash: res.transactionHash, block: res.height ?? 0 }),
      });
      writeRecord(record);
    } finally {
      tx.disconnect();
    }
  }
}

interface ForgeDryRun {
  transactions: { contractName: string; transactionType: string; transaction: { input?: Hex; data?: Hex } }[];
}

/** Run the forge script as a simulation from `sender` and return the CREATE's init code. */
function forgeInitCode(setup: EvmSetup, sender: Hex): Hex {
  execFileSync("forge", ["script", SCRIPT, "--rpc-url", setup.network.evmRpc, "--sender", sender], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const run = JSON.parse(readFileSync(DRY_RUN_LOG, "utf8")) as ForgeDryRun;
  const create = run.transactions.find((t) => t.contractName === "FlightEscrow" && t.transactionType === "CREATE");
  const input = create?.transaction.input ?? create?.transaction.data;
  if (!input) throw new Error(`No FlightEscrow CREATE in ${DRY_RUN_LOG}`);
  return input;
}

async function deploy(setup: EvmSetup, record: DeploymentRecord): Promise<void> {
  const clients = makeClients(setup.network);
  const { reads } = clients;
  const signer = setup.roles.owner.signer;
  if (record.contract) {
    const code = await reads.getCode({ address: record.contract.address });
    if (code && code !== "0x") {
      console.log(`FlightEscrow already deployed at ${record.contract.address}; skipping.`);
      return;
    }
  }
  // A CREATE that landed without being recorded would sit at one of the signer's past nonces.
  // Superseded deployments and the other recorded contracts are known and expected there.
  const known = new Set([...(record.superseded ?? []).map((s) => s.contract.address), ...(record.otherContracts ?? []).map((c) => c.address)].map((a) => a.toLowerCase()));
  const nonce = await reads.getTransactionCount({ address: signer.address, blockTag: "latest" });
  for (let n = 0; n < nonce; n++) {
    const address = getContractAddress({ from: signer.address, nonce: BigInt(n) });
    if (known.has(address.toLowerCase())) continue;
    const code = await reads.getCode({ address });
    if (code && code !== "0x") throw new Error(`Owner signer already created ${address} (nonce ${n}); record it by hand.`);
  }

  await openWindow(setup, record, "owner", ownerDeployWindow(), "deploy + openMandate");

  console.log(`Simulating the deploy with forge script from owner signer ${signer.address} ...`);
  const initCode = forgeInitCode(setup, signer.address);
  const receipt = await sendTx(clients, walletFor(clients, signer.privateKey), {
    label: "FlightEscrow deploy",
    data: initCode,
    gasCap: GAS_CAP.deploy,
  });
  if (!receipt.contractAddress) throw new Error(`Deploy ${receipt.transactionHash} created no contract`);
  record.contract = {
    address: getAddress(receipt.contractAddress),
    deployer: signer.address,
    deployTx: txRecord(setup.network.explorer, {
      hash: receipt.transactionHash,
      block: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    }),
  };
  writeRecord(record);
  console.log(`FlightEscrow ${receipt.contractAddress} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)`);
  console.log(`  ${record.contract.deployTx.url}`);
}

async function main(): Promise<void> {
  const setup = await loadEvmSetup();
  const record = readRecord(setup.network.explorer);
  await fundSigners(setup, record);
  await registerSigner(setup, record, "owner");
  await registerSigner(setup, record, "agent");
  await deploy(setup, record);
}

main().catch((err: unknown) => {
  console.error(`\nescrow:deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
