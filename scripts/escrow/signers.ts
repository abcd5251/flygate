// Get an EVM signer admitted to diana's EVM lane: registered PQC key, then an open window.
// Both steps check the chain first and are skipped when already in place.
import type { Role } from "../bootstrap/env";
import type { EvmSetup } from "../evm/chain";
import { ensureSignerPqc, ensureWindow, unifiedSigner, type WindowSpec } from "./native";
import { explorerTx, writeRecord, type DeploymentRecord } from "./record";

export async function registerSigner(setup: EvmSetup, record: DeploymentRecord, role: Role): Promise<void> {
  const evmRole = setup.roles[role];
  const unified = await unifiedSigner(evmRole, setup.mnemonics[role]);
  const tx = await ensureSignerPqc(setup.network, evmRole, unified);
  if (!tx) {
    console.log(`${role} signer ${evmRole.signer.address}: ML-DSA-87 key already registered and proven; skipping.`);
    return;
  }
  console.log(`${role} signer ML-DSA-87 key registered with proof of possession: ${tx.hash}`);
  (record.pqcRegistrations ??= []).push({
    label: `${role} EVM signer ${unified.cosmos}`,
    tx: { ...tx, url: explorerTx(setup.network.explorer, tx.hash) },
  });
  writeRecord(record);
}

export async function openWindow(
  setup: EvmSetup,
  record: DeploymentRecord,
  role: Role,
  spec: WindowSpec,
  purpose: string,
): Promise<void> {
  const evmRole = setup.roles[role];
  const unified = await unifiedSigner(evmRole, setup.mnemonics[role]);
  const tx = await ensureWindow(setup.network, evmRole, unified, spec);
  if (!tx) {
    console.log(`${role} signer: open EVM window already covers ${purpose}; skipping.`);
    return;
  }
  console.log(
    `${role} signer EVM window (${spec.maxTxs} txs, ${spec.maxValue} uqor, ${spec.openBlocks} blocks` +
      `${spec.target ? `, only ${spec.target}` : ""}) for ${purpose}: ${tx.hash}`,
  );
  (record.evmWindows ??= []).push({
    label: `${role} EVM signer: ${purpose}`,
    maxTxs: spec.maxTxs,
    maxValueUqor: spec.maxValue.toString(),
    blocks: spec.openBlocks,
    allowedTargets: spec.target ? [spec.target] : [],
    tx: { ...tx, url: explorerTx(setup.network.explorer, tx.hash) },
  });
  writeRecord(record);
}
