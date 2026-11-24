// The committed deployment record: deployments/diana.json. Holds addresses and tx hashes only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Hex } from "../evm/keys";

export const RECORD_PATH = resolve(import.meta.dirname, "../../deployments/diana.json");

export interface TxRecord {
  hash: string;
  block: number;
  /** Gas used, from the receipt. EVM txs only. */
  gasUsed?: number;
  url: string;
}

export interface FlowRecord {
  bookingId: Hex;
  book: TxRecord;
  [step: string]: TxRecord | Hex;
}

export interface DeploymentRecord {
  network: string;
  evmChainId: number;
  explorer: string;
  contract?: { address: Hex; deployer: Hex; deployTx: TxRecord };
  /** Bank sends that funded the EVM signers (qor1 account -> signer's qor1 form). */
  funding: { label: string; amountUqor: string; tx: TxRecord }[];
  mandate?: { owner: Hex; agent: Hex; merchant: Hex; tx: TxRecord };
  flows: { confirm?: FlowRecord; cancel?: FlowRecord; refund?: FlowRecord };
  gas?: { book: number; confirmTicket: number; cancel: number; refund: number };
}

export function emptyRecord(explorer: string): DeploymentRecord {
  return { network: "qorechain-diana", evmChainId: 9800, explorer, funding: [], flows: {} };
}

export function readRecord(explorer: string, path: string = RECORD_PATH): DeploymentRecord {
  if (!existsSync(path)) return emptyRecord(explorer);
  return JSON.parse(readFileSync(path, "utf8")) as DeploymentRecord;
}

export function writeRecord(record: DeploymentRecord, path: string = RECORD_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

export const explorerTx = (explorer: string, hash: string) => `${explorer}/tx/${hash}`;
