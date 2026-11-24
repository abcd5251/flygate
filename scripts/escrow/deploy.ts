// `pnpm escrow:deploy` - get the owner and agent EVM signers onto diana's EVM lane and
// deploy FlightEscrow. Every step reads the chain first and is skipped when already done;
// rerun after any failure.
//   1. Bank sends (hybrid-signed): owner qor1 -> owner signer, agent qor1 -> agent signer,
//      only when the signer is below its minimum.
//   2. ML-DSA-87 key with proof of possession for each signer (MsgRegisterPQCKeyV2).
//   3. Owner signer EVM window sized for the CREATE plus one setMandate (MsgOpenEVMWindow).
//   4. `forge script contracts/script/DeployFlightEscrow.s.sol` simulates the deploy from the
//      owner signer; the recorded CREATE is then signed here and broadcast once.
// Writes deployments/diana.json. Never prints keys.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, getContractAddress } from "viem";
import { balanceOf, connect, DENOM, deriveRole, formatQor, makeClient } from "../bootstrap/chain";
import type { Role } from "../bootstrap/env";
import { loadEvmSetup, type EvmSetup } from "../evm/chain";
import type { Hex } from "../evm/keys";
import { GAS_CAP, ownerDeployWindow } from "./budget";
import { topUpAmount, type TopUpRule } from "./plan";
import { explorerTx, readRecord, writeRecord, type DeploymentRecord } from "./record";
import { openWindow, registerSigner } from "./signers";
import { makeClients, sendTx, walletFor } from "./tx";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = "contracts/script/DeployFlightEscrow.s.sol";
const DRY_RUN_LOG = resolve(ROOT, "broadcast/DeployFlightEscrow.s.sol/9800/dry-run/run-latest.json");

const QOR = BigInt(1_000_000);
/**
 * Owner signer: deploy + setMandate gas, and it receives every refund.
 * Agent signer: three 1-QOR fares plus gas per e2e run.
 */
const SIGNER_FUNDING: Partial<Record<Role, TopUpRule>> = {
  owner: { min: QOR, target: BigInt(2) * QOR },
  agent: { min: BigInt(4) * QOR, target: BigInt(5) * QOR },
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
        tx: {
          hash: res.transactionHash,
          block: Number(res.height ?? 0),
          url: explorerTx(setup.network.explorer, res.transactionHash),
        },
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
  const nonce = await reads.getTransactionCount({ address: signer.address, blockTag: "latest" });
  for (let n = 0; n < nonce; n++) {
    const address = getContractAddress({ from: signer.address, nonce: BigInt(n) });
    const code = await reads.getCode({ address });
    if (code && code !== "0x") throw new Error(`Owner signer already created ${address} (nonce ${n}); record it by hand.`);
  }

  await openWindow(setup, record, "owner", ownerDeployWindow(), "deploy + setMandate");

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
    deployTx: {
      hash: receipt.transactionHash,
      block: Number(receipt.blockNumber),
      gasUsed: Number(receipt.gasUsed),
      url: explorerTx(setup.network.explorer, receipt.transactionHash),
    },
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
