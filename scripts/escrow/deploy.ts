// `pnpm escrow:deploy` - fund the owner and agent EVM signers, then deploy FlightEscrow
// to diana with `forge script`. Every step is idempotent; rerun after any failure.
//   1. Bank sends (hybrid-signed): owner qor1 -> owner signer, agent qor1 -> agent signer,
//      only when the signer is below its minimum.
//   2. forge script contracts/script/DeployFlightEscrow.s.sol --broadcast, from the owner
//      signer. Skipped when deployments/diana.json already names a contract with code.
// Writes deployments/diana.json. Never prints keys.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect, deriveRole, formatQor, balanceOf, DENOM, makeClient } from "../bootstrap/chain";
import type { Role } from "../bootstrap/env";
import { loadEvmSetup, type EvmSetup } from "../evm/chain";
import type { Hex } from "../evm/keys";
import { topUpAmount, type TopUpRule } from "./plan";
import { explorerTx, readRecord, writeRecord, type DeploymentRecord } from "./record";
import { makeClients } from "./tx";

const ROOT = resolve(import.meta.dirname, "../..");
const SCRIPT = "contracts/script/DeployFlightEscrow.s.sol";
const BROADCAST_LOG = resolve(ROOT, "broadcast/DeployFlightEscrow.s.sol/9800/run-latest.json");

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

interface ForgeRun {
  transactions: { hash: Hex; contractName: string; contractAddress: Hex; transactionType: string }[];
  receipts: { transactionHash: Hex; blockNumber: Hex; gasUsed: Hex; status: Hex; contractAddress: Hex }[];
}

async function deploy(setup: EvmSetup, record: DeploymentRecord): Promise<void> {
  const { reads } = makeClients(setup.network);
  if (record.contract) {
    const code = await reads.getCode({ address: record.contract.address });
    if (code && code !== "0x") {
      console.log(`FlightEscrow already deployed at ${record.contract.address}; skipping.`);
      return;
    }
  }
  const signer = setup.roles.owner.signer;
  // A previous forge run may have landed without the record being written: reuse it.
  if (!existsSync(BROADCAST_LOG)) {
    console.log(`Deploying FlightEscrow from owner signer ${signer.address} ...`);
    // forge sends the tx once and waits for its receipt; it does not resend on errors.
    execFileSync(
      "forge",
      ["script", SCRIPT, "--rpc-url", setup.network.evmRpc, "--broadcast", "--slow", "--non-interactive"],
      { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, DEPLOYER_PRIVATE_KEY: signer.privateKey } },
    );
  }
  const run = JSON.parse(readFileSync(BROADCAST_LOG, "utf8")) as ForgeRun;
  const create = run.transactions.find((t) => t.contractName === "FlightEscrow" && t.transactionType === "CREATE");
  const receipt = run.receipts.find((r) => r.transactionHash === create?.hash);
  if (!create || !receipt || receipt.status !== "0x1") throw new Error(`No successful FlightEscrow CREATE in ${BROADCAST_LOG}`);
  record.contract = {
    address: create.contractAddress,
    deployer: signer.address,
    deployTx: {
      hash: create.hash,
      block: Number(receipt.blockNumber),
      gasUsed: Number(receipt.gasUsed),
      url: explorerTx(setup.network.explorer, create.hash),
    },
  };
  writeRecord(record);
  console.log(`FlightEscrow ${create.contractAddress} (block ${Number(receipt.blockNumber)})`);
}

async function main(): Promise<void> {
  const setup = await loadEvmSetup();
  const record = readRecord(setup.network.explorer);
  await fundSigners(setup, record);
  await deploy(setup, record);
}

main().catch((err: unknown) => {
  console.error(`\nescrow:deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
