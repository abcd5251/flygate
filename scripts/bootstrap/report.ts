// Verification table printed at the end of every run.
import { AlgorithmDilithium5, algorithmName, type PqcStatus } from "@qorechain/sdk";
import { formatQor } from "./chain";
import type { Role } from "./env";

export interface AccountRow {
  role: Role;
  address: string;
  balance: bigint;
  pqc: PqcStatus;
}

export interface SentTx {
  label: string;
  hash: string;
}

// explore.qore.network routes (probed): /tx/{hash}, /address/{addr}. The explorer
// picks mainnet/testnet from a cookie (default mainnet): switch it to Testnet.
export const explorerTxUrl = (explorer: string, hash: string) => `${explorer}/tx/${hash}`;
export const explorerAddressUrl = (explorer: string, address: string) => `${explorer}/address/${address}`;

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function algorithm(pqc: PqcStatus): string {
  if (pqc.algorithmId === undefined) return "-";
  const name = algorithmName(pqc.algorithmId);
  return pqc.algorithmId === AlgorithmDilithium5 ? name : `${name} (expected ${algorithmName(AlgorithmDilithium5)})`;
}

export function printReport(explorer: string, accounts: AccountRow[], txs: SentTx[]): void {
  console.log("\nVerification (qorechain-diana)\n");
  console.log(
    table(
      ["role", "address", "balance", "registered", "algorithmId", "possessionProven"],
      accounts.map((a) => [
        a.role,
        a.address,
        formatQor(a.balance),
        String(a.pqc.registered),
        algorithm(a.pqc),
        a.pqc.possessionProven === undefined ? "-" : String(a.pqc.possessionProven),
      ]),
    ),
  );
  console.log("\nExplorer (set the explorer's network toggle to Testnet):");
  for (const a of accounts) console.log(`  ${a.role.padEnd(8)} ${explorerAddressUrl(explorer, a.address)}`);
  console.log("\nTransactions sent this run:");
  if (txs.length === 0) console.log("  (none)");
  for (const t of txs) console.log(`  ${t.label}: ${t.hash}\n    ${explorerTxUrl(explorer, t.hash)}`);
}
