// Leak check for the client bundle (D-07, second line of defence after `server-only`).
// Run after `next build` (`pnpm check:bundle` builds first): scans every file Next.js serves to
// the browser under .next/static and fails if any contains a key-handling signature.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const STATIC_DIR = join(ROOT, ".next", "static");

/** Strings that only server code may contain: mnemonic env vars, the SDK and its EVM-auth code. */
export const SIGNATURES = ["MNEMONIC", "qorechain-evm-auth", "@qorechain/sdk"];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

function main() {
  if (!existsSync(STATIC_DIR)) {
    console.error(`No client build output at ${relative(ROOT, STATIC_DIR)}. Run \`next build\` first.`);
    process.exit(1);
  }
  let scanned = 0;
  const hits: string[] = [];
  for (const path of files(STATIC_DIR)) {
    scanned += 1;
    const text = readFileSync(path, "latin1");
    for (const sig of SIGNATURES) if (text.includes(sig)) hits.push(`${relative(ROOT, path)}: contains "${sig}"`);
  }
  if (hits.length > 0) {
    console.error(`Client bundle leak check FAILED (${hits.length} hit${hits.length === 1 ? "" : "s"}):`);
    for (const h of hits) console.error(`  ${h}`);
    console.error("Server-only code (keys, @qorechain/sdk) reached the browser bundle. Find the client import and remove it.");
    process.exit(1);
  }
  console.log(`Client bundle leak check passed: ${scanned} files in ${relative(ROOT, STATIC_DIR)}, no ${SIGNATURES.join(" / ")}.`);
}

main();
