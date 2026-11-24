// The committed deployment record: deployments/diana.json. Holds addresses and tx hashes only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Hex } from "viem";
import { DIANA_EVM_CHAIN_ID } from "../../src/lib/chain";
import { explorerTxUrl } from "../bootstrap/report";

export const RECORD_PATH = resolve(import.meta.dirname, "../../deployments/diana.json");

export interface TxRecord {
  hash: string;
  block: number;
  /** Gas used, from the receipt. EVM txs only. */
  gasUsed?: number;
  url: string;
}

/** A landed tx (native or EVM receipt) as a record entry with its explorer link. */
export function txRecord(explorer: string, tx: { hash: string; block: number | bigint; gasUsed?: number | bigint }): TxRecord {
  return {
    hash: tx.hash,
    block: Number(tx.block),
    ...(tx.gasUsed !== undefined ? { gasUsed: Number(tx.gasUsed) } : {}),
    url: explorerTxUrl(explorer, tx.hash),
  };
}

export interface FlowRecord {
  bookingId: Hex;
  book: TxRecord;
  [step: string]: TxRecord | Hex;
}

export interface WindowRecord {
  label: string;
  maxTxs: number;
  maxValueUqor: string;
  blocks: number;
  allowedTargets: string[];
  tx: TxRecord;
}

export interface ContractRecord {
  address: Hex;
  deployer: Hex;
  deployTx: TxRecord;
}

/** An earlier deployment kept for its links, with why it was replaced. */
export interface SupersededRecord {
  reason: string;
  contract: ContractRecord;
  mandate?: DeploymentRecord["mandate"];
  evmWindows?: WindowRecord[];
  flows: DeploymentRecord["flows"];
  gas?: DeploymentRecord["gas"];
}

export interface DeploymentRecord {
  network: string;
  evmChainId: number;
  explorer: string;
  contract?: ContractRecord;
  /** Bank sends that funded the EVM signers (qor1 account -> signer's qor1 form). */
  funding: { label: string; amountUqor: string; tx: TxRecord }[];
  /** ML-DSA-87 registrations (with proof of possession) for the EVM signers. */
  pqcRegistrations?: { label: string; tx: TxRecord }[];
  /** MsgOpenEVMWindow txs for the current deployment, with the bounds each was opened with. */
  evmWindows?: WindowRecord[];
  mandate?: { owner: Hex; agent: Hex; merchant: Hex; tx: TxRecord };
  flows: { confirm?: FlowRecord; cancel?: FlowRecord; refund?: FlowRecord };
  gas?: { deploy?: number; setMandate?: number; book: number; confirmTicket: number; cancel: number; refund: number };
  superseded?: SupersededRecord[];
}

export function emptyRecord(explorer: string): DeploymentRecord {
  return { network: "qorechain-diana", evmChainId: DIANA_EVM_CHAIN_ID, explorer, funding: [], flows: {} };
}

export function readRecord(explorer: string, path: string = RECORD_PATH): DeploymentRecord {
  if (!existsSync(path)) return emptyRecord(explorer);
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
}

export function writeRecord(record: DeploymentRecord, path: string = RECORD_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}
