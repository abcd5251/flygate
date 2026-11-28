// `pnpm live:probe-crossvm` - checks on diana what the wallet-signed Live flow (ADR-0003) relies
// on: a QoreX-style account (secp256k1, coin 118, qor1...) calls an EVM contract with
// MsgCrossVMCall + funds, the only way a QoreX user can reach FlightEscrow (QoreX signs Cosmos
// messages only, and refuses MsgOpenEVMWindow from a dApp).
//
//   1. msg.sender of the EVM call is the account's 0x (the hex of its 20 address bytes)
//   2. `funds` arrive as msg.value (1 uqor = 1e12 wei)
//   3. whether the account needs an open EVM window for it
//
// Sends SMALL REAL transactions from the owner role in .env.local (the stand-in QoreX user):
// one ProbeRecorder deploy from the owner's coin-60 signer (opening its window if needed) and
// one MsgCrossVMCall carrying 0.001 QOR. A broadcast is never retried. Pass the bytecode of
// contracts/probe/ProbeRecorder.sol with --bin <file> (forge or solcjs output).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyEvmWindowRejection, deriveUnifiedAccount, fetchEvmWindow, msg as composers, qoreAddresses } from "@qorechain/sdk";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, parseAbi, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { balanceOf, connect, deriveRole, makeClient, retrying } from "../bootstrap/chain";
import { DIANA_EVM_CHAIN_ID } from "../../src/lib/chain";
import { deriveEvmRole } from "../evm/keys";
import { openSignerWindow } from "./eth-native";
import { assertNoSecrets, readProbeEnvFrom, WEI_PER_UQOR } from "./probe-lib";

const ROOT = resolve(import.meta.dirname, "../..");
const PROBE_ABI = parseAbi([
  "function allowed() payable",
  "function lastSender() view returns (address)",
  "function lastValue() view returns (uint256)",
  "function calls() view returns (uint256)",
]);
const VALUE_UQOR = BigInt(1_000);

let SECRETS: string[] = [];
function say(line: string): void {
  assertNoSecrets(line, SECRETS);
  console.log(line);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const binAt = args.indexOf("--bin");
  if (binAt < 0 || !args[binAt + 1]) throw new Error("Usage: pnpm live:probe-crossvm --bin <ProbeRecorder.bin> [--probe 0x...]");
  const probeAt = args.indexOf("--probe");
  const env = readProbeEnvFrom(join(ROOT, ".env.local"));
  const owner = await deriveRole("owner", env.mnemonics.owner);
  const evm = await deriveEvmRole("owner", env.mnemonics.owner);
  const unified = await deriveUnifiedAccount(env.mnemonics.owner);
  SECRETS = [env.mnemonics.owner, evm.signer.privateKey];
  const client = makeClient(env.network);
  const chain = defineChain({
    id: DIANA_EVM_CHAIN_ID,
    name: "qorechain-diana",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [env.network.evmRpc] } },
  });
  const pub = createPublicClient({ chain, transport: http(env.network.evmRpc) }) as PublicClient;

  say(`account ${owner.address} (EVM view ${evm.account.evm}), balance ${await balanceOf(client, owner.address)} uqor`);
  say(`signer  ${evm.signer.address}, balance ${await pub.getBalance({ address: evm.signer.address })} wei`);
  const accountWindow = await retrying(() => fetchEvmWindow({ rest: env.network.rest, address: owner.address }));
  say(`account EVM window: live=${accountWindow.live} remainingTxs=${accountWindow.remainingTxs} remainingBlocks=${accountWindow.remainingBlocks}`);

  let probe: Hex;
  if (probeAt >= 0 && args[probeAt + 1]) {
    probe = args[probeAt + 1] as Hex;
  } else {
    const bytecode = `0x${readFileSync(args[binAt + 1], "utf8").trim().replace(/^0x/, "")}` as Hex;
    const wallet = createWalletClient({ account: privateKeyToAccount(evm.signer.privateKey), chain, transport: http(env.network.evmRpc, { retryCount: 0 }) });
    const deploy = () => wallet.deployContract({ abi: PROBE_ABI, bytecode, chain });
    let hash: Hex;
    try {
      hash = await deploy();
    } catch (err) {
      const why = classifyEvmWindowRejection(err);
      if (why !== "no-window" && why !== "exhausted") throw err;
      const w = await openSignerWindow({ client, rest: env.network.rest, chainId: env.network.chainId }, unified, { blocks: 600, maxTxs: 2, maxValue: "1000000" });
      say(`opened signer window ${w}`);
      hash = await deploy();
    }
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${hash} failed`);
    probe = r.contractAddress;
    say(`ProbeRecorder deployed at ${probe} (tx ${hash})`);
  }

  const tx = await connect(client, owner);
  // The EVM lane of MsgCrossVMCall refuses `funds` ("the evm lane cannot transfer funds; send
  // them separately"), so value goes as a MsgSend to the contract in the same tx, then the call.
  const send = composers.bank.send({
    fromAddress: owner.address,
    toAddress: qoreAddresses({ evm: probe }).cosmos,
    amount: [{ denom: "uqor", amount: VALUE_UQOR.toString() }],
  });
  const call = composers.crossvm.crossVmCall({
    sender: owner.address,
    // The chain derives the real origin lane, but ValidateBasic still wants a VM that differs from targetVm.
    sourceVm: "cosmwasm",
    targetVm: "evm",
    targetContract: probe,
    payload: new Uint8Array(Buffer.from(encodeFunctionData({ abi: PROBE_ABI, functionName: "allowed" }).slice(2), "hex")),
    funds: [],
    async: false,
  });
  const before = await pub.readContract({ address: probe, abi: PROBE_ABI, functionName: "calls" });
  const balBefore = await pub.getBalance({ address: probe });
  const res = await tx.signAndBroadcast([send, call], "auto");
  say(`MsgSend + MsgCrossVMCall tx ${res.transactionHash}: code ${res.code}${res.code !== 0 ? ` ${res.rawLog ?? ""}` : ""}`);
  const after = await pub.readContract({ address: probe, abi: PROBE_ABI, functionName: "calls" });
  const balAfter = await pub.getBalance({ address: probe });
  const sender = await pub.readContract({ address: probe, abi: PROBE_ABI, functionName: "lastSender" });
  const value = await pub.readContract({ address: probe, abi: PROBE_ABI, functionName: "lastValue" });
  say(`calls ${before} -> ${after}; lastSender ${sender}; lastValue ${value} wei; contract balance ${balBefore} -> ${balAfter} wei`);
  say(`1. msg.sender is the account's 0x: ${sender.toLowerCase() === evm.account.evm.toLowerCase()}`);
  say(`2. the MsgSend reached the contract's EVM balance before the call: ${balAfter - balBefore === VALUE_UQOR * WEI_PER_UQOR}`);
  say(`3. account window was live before the call: ${accountWindow.live}`);
}

main().catch((err) => {
  const text = err instanceof Error ? err.message : String(err);
  try {
    assertNoSecrets(text, SECRETS);
    console.error(`crossvm-probe failed: ${text}`);
  } catch {
    console.error("crossvm-probe failed (message withheld: it contained key material)");
  }
  process.exitCode = 1;
});
