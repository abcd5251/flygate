// Get an EVM signer admitted to diana's EVM lane: registered PQC key, then an open window.
// Both steps check the chain first and are skipped when already in place.
import type { UnifiedAccount } from "@qorechain/sdk";
import type { Role } from "../bootstrap/env";
import type { EvmSetup } from "../evm/chain";
import type { EvmRole } from "../evm/keys";
import { ensureSignerPqc, ensureWindow, unifiedSigner, type NativeTx, type WindowSpec } from "./native";
import { txRecord, writeRecord, type DeploymentRecord, type TxRecord } from "./record";

/**
 * Run one check-then-send step for the role's signer. `ensure` returns undefined when the
 * chain already has what is needed; otherwise the landed tx is recorded and saved.
 */
async function signerStep(
  setup: EvmSetup,
  record: DeploymentRecord,
  role: Role,
  ensure: (evmRole: EvmRole, unified: UnifiedAccount) => Promise<NativeTx | undefined>,
  log: { skipped: string; sent: (hash: string) => string },
  save: (tx: TxRecord, unified: UnifiedAccount) => void,
): Promise<void> {
  const evmRole = setup.roles[role];
  const unified = await unifiedSigner(evmRole, setup.mnemonics[role]);
  const tx = await ensure(evmRole, unified);
  if (!tx) {
    console.log(log.skipped);
    return;
  }
  console.log(log.sent(tx.hash));
  save(txRecord(setup.network.explorer, tx), unified);
  writeRecord(record);
}

export function registerSigner(setup: EvmSetup, record: DeploymentRecord, role: Role): Promise<void> {
  return signerStep(
    setup,
    record,
    role,
    (evmRole, unified) => ensureSignerPqc(setup.network, evmRole, unified),
    {
      skipped: `${role} signer ${setup.roles[role].signer.address}: ML-DSA-87 key already registered and proven; skipping.`,
      sent: (hash) => `${role} signer ML-DSA-87 key registered with proof of possession: ${hash}`,
    },
    (tx, unified) => (record.pqcRegistrations ??= []).push({ label: `${role} EVM signer ${unified.cosmos}`, tx }),
  );
}

export function openWindow(
  setup: EvmSetup,
  record: DeploymentRecord,
  role: Role,
  spec: WindowSpec,
  purpose: string,
): Promise<void> {
  return signerStep(
    setup,
    record,
    role,
    (evmRole, unified) => ensureWindow(setup.network, evmRole, unified, spec),
    {
      skipped: `${role} signer: open EVM window already covers ${purpose}; skipping.`,
      sent: (hash) =>
        `${role} signer EVM window (${spec.txs} txs, ${spec.value} uqor, ${spec.openBlocks} blocks` +
        `${spec.target ? `, only ${spec.target}` : ""}) for ${purpose}: ${hash}`,
    },
    (tx) =>
      (record.evmWindows ??= []).push({
        label: `${role} EVM signer: ${purpose}`,
        maxTxs: spec.txs,
        maxValueUqor: spec.value.toString(),
        blocks: spec.openBlocks,
        allowedTargets: spec.target ? [spec.target] : [],
        tx,
      }),
  );
}
