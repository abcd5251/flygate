// `pnpm live:probe` - check on diana the chain behaviour the live-checkout spec (§4.3) relies
// on, before the Live flow is built on it (#17, D-11). Sends SMALL REAL transactions.
//
//   1. MsgExecuteEVM through the Linked agent key: msg.sender / msg.value are the owner account's
//   2. what a coin-60 signer needs before its EVM txs are admitted (PQC key, Scoped window)
//   3. allowedEvmCalls "0x<contract>/0x<selector>" lets one function through and stops another
//   4. whether an account's window governs MsgExecuteEVM
//   5. whether the explorer shows a 0x EVM tx hash (asks the person running it)
//   6. a merchant signature from derivePqcCanonical + src/lib/escrow.ts verifies on chain
//
// Rules (as in `pnpm bootstrap`): reads and connecting are retried on rate limiting; a
// broadcast is never retried. A broadcast that errors ends its item ("inconclusive") instead.
// A second send after a refusal is a NEW transaction made after fixing the refusal's cause
// (register a key, open a window), never a resend of the refused one.
//
// Mnemonics come from the server env (or .env.local), read-only. Nothing secret is printed or
// written: every output line passes assertNoSecrets first.
//
// Writes the record into docs/FLOW.md (between the live:probe markers) and, when a decision
// is overturned, a comment body for #16 to post with `gh issue comment 16 --body-file`.
//
// Flags: --yes (skip the confirmation), --no-prompt (do not ask about the explorer).
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  assertAuthenticatorExecutionsSucceeded,
  AuthenticatorExecutionError,
  buildMetaMaskExecuteEvm,
  buildRegisterPqcKeyMsg,
  classifyEvmWindowRejection,
  closeEvmWindowMsg,
  deriveUnifiedAccount,
  EthNativeSigner,
  fetchAuthenticators,
  fetchAuthNonce,
  fetchEvmWindow,
  fetchPqcStatus,
  clearPqcStatusCache,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  QoreTxError,
  resolveEvmAuthDigestVersion,
  signAuthenticatorLinkEip191,
  signProofOfPossession,
  VERSION,
  waitForTx,
  type EthBroadcaster,
  type QoreChainClient,
  type TxClient,
  type UnifiedAccount,
} from "@qorechain/sdk";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
  zeroAddress,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { connect, deriveRole, makeClient, retrying, type RoleAccount } from "../bootstrap/chain";
import { ROLES, type Role } from "../bootstrap/env";
import { DIANA_EVM_CHAIN_ID, evmBalance, evmChainId, pqcKeyStatusOnEvm } from "../evm/chain";
import { deriveEvmRole, type EvmRole } from "../evm/keys";
import { Cabin, DIANA_CHAIN_ID, quoteMessage, signMessage, verifyMessage, type Quote } from "../../src/lib/escrow";
import {
  allowedEvmCall,
  assertNoSecrets,
  describeExec,
  describeSenderStep,
  errorText,
  explorerTxUrl,
  feeUqor,
  judgeExecuteSender,
  judgeExplorer,
  judgePqcVerify,
  judgeSelectorRule,
  judgeSenderPrerequisites,
  judgeWindowGovernsExecute,
  readProbeEnvFrom,
  renderIssueComment,
  renderRecord,
  replaceRecord,
  uqorToWei,
  type ExecOutcome,
  type Hex,
  type ItemId,
  type ItemResult,
  type ProbeEnv,
  type SenderStep,
  type TxRef,
  type Verdict,
} from "./probe-lib";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_PATH = join(ROOT, ".env.local");
const FLOW_PATH = join(ROOT, "docs/FLOW.md");
const ARTIFACT_PATH = join(ROOT, "contracts/out/ProbeRecorder.sol/ProbeRecorder.json");

const QOR = BigInt(1_000_000); // uqor
/** Fund a coin-60 signer up to this when it holds less than SIGNER_MIN. */
const SIGNER_TOP_UP = BigInt(3) * QOR;
const SIGNER_MIN = BigInt(2) * QOR;
/** The value each MsgExecuteEVM carries: 0.001 QOR. */
const EXEC_VALUE_UQOR = BigInt(1_000);
const EXEC_GAS_LIMIT = 200_000;
/** Explicit gas for the eth-native Cosmos txs (registration carries a 2592-byte key + 4627-byte proof). */
const REGISTER_GAS = 1_000_000;
const WINDOW_GAS = 500_000;
const GAS_PRICE_UQOR = "0.15";
/** Signer windows: ~20 minutes, a few txs, 2 QOR including fees. */
const SIGNER_WINDOW = { blocks: 1_200, maxTxs: 5, maxValue: (BigInt(2) * QOR).toString() };
/** A target no one calls: the window that only admits it must not admit the probe. */
const DECOY_TARGET = "0x000000000000000000000000000000000000dEaD";

const PROBE_ABI = parseAbi([
  "function allowed() payable",
  "function blocked() payable",
  "function lastSender() view returns (address)",
  "function lastValue() view returns (uint256)",
  "function lastSelector() view returns (bytes4)",
  "function calls() view returns (uint256)",
]);
const PQC_VERIFY_ABI = parseAbi(["function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)"]);
const PQC_VERIFY_ADDRESS = "0x0000000000000000000000000000000000000a01";
const ALLOWED_SELECTOR = encodeFunctionData({ abi: PROBE_ABI, functionName: "allowed" });
const BLOCKED_SELECTOR = encodeFunctionData({ abi: PROBE_ABI, functionName: "blocked" });

interface Ctx {
  env: ProbeEnv;
  client: QoreChainClient;
  pub: PublicClient;
  chain: ReturnType<typeof defineChain>;
  /** coin-118 bootstrap accounts (qor1, hybrid-signing). */
  roles: Record<Role, RoleAccount>;
  /** account (bootstrap 0x view) and signer (coin-60) per role. */
  evm: Record<Role, EvmRole>;
  items: Map<ItemId, ItemResult>;
  probe?: Address;
}

// ------------------------------------------------------------------ output

let SECRETS: string[] = [];
function say(line = ""): void {
  assertNoSecrets(line, SECRETS);
  console.log(line);
}

function setItem(ctx: Ctx, id: ItemId, verdict: Verdict, summary: string, evidence: string[], txs: TxRef[]): void {
  ctx.items.set(id, { id, verdict, summary, evidence, txs });
  say(`  -> item ${id}: ${verdict}. ${summary}`);
}

// ------------------------------------------------------------------ cosmos helpers

/** Account number and sequence over REST (an eth-native account's pubkey type is not cosmjs's). */
async function accountSequence(ctx: Ctx, address: string): Promise<{ accountNumber: bigint; sequence: bigint }> {
  type Acc = { account_number?: string; sequence?: string; base_account?: Acc };
  const body = await retrying(() => ctx.client.rest.get<{ account?: Acc }>(`/cosmos/auth/v1beta1/accounts/${address}`));
  const acc = body.account?.base_account ?? body.account;
  if (!acc?.account_number) throw new Error(`No account record for ${address} (fund it first)`);
  return { accountNumber: BigInt(acc.account_number), sequence: BigInt(acc.sequence ?? "0") };
}

/** Raw tx bytes -> REST broadcast (sync, once) -> wait for inclusion (a read, so retried). */
function restBroadcaster(ctx: Ctx): EthBroadcaster {
  return {
    async broadcastTx(tx: Uint8Array) {
      const res = await fetch(`${ctx.env.network.rest}/cosmos/tx/v1beta1/txs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_bytes: Buffer.from(tx).toString("base64"), mode: "BROADCAST_MODE_SYNC" }),
      });
      if (!res.ok) throw new Error(`broadcast: HTTP ${res.status} (not resent)`);
      const body = (await res.json()) as { tx_response?: { code: number; txhash: string; raw_log?: string; codespace?: string } };
      const t = body.tx_response;
      if (!t) throw new Error("broadcast: no tx_response (not resent)");
      if (t.code !== 0) return { code: t.code, transactionHash: t.txhash, rawLog: `${t.codespace ?? ""} ${t.raw_log ?? ""}`.trim() };
      const included = await retrying(() => waitForTx(ctx.client.rest, t.txhash, { timeoutMs: 60_000, pollIntervalMs: 1_500 }));
      return { code: included.code, transactionHash: included.txHash, height: included.height, rawLog: included.rawLog };
    },
  };
}

const stdFee = (gas: number) => ({ amount: [{ denom: "uqor", amount: feeUqor(gas, GAS_PRICE_UQOR).toString() }], gas: String(gas) });

/** One eth-native Cosmos tx from a coin-60 signer. Broadcast once; throws on a non-zero code. */
async function sendEthNative(
  ctx: Ctx,
  who: UnifiedAccount,
  mode: "classical" | "hybrid",
  messages: ReturnType<typeof openEvmWindowMsg>[],
  gas: number,
): Promise<string> {
  const signer = new EthNativeSigner(who, { signMode: mode, signBytesVersion: "auto", rest: ctx.env.network.rest });
  const seq = await accountSequence(ctx, who.cosmos);
  const res = await signer.signAndBroadcast(restBroadcaster(ctx), {
    chainId: ctx.env.network.chainId,
    messages,
    fee: stdFee(gas),
    ...seq,
  });
  if (res.code !== 0) throw new Error(`code ${res.code} ${res.transactionHash}: ${res.rawLog ?? ""}`);
  return res.transactionHash;
}

async function ownerBroadcast(tx: TxClient, messages: ReturnType<typeof openEvmWindowMsg>[]): Promise<string> {
  const res = await tx.signAndBroadcast(messages, "auto");
  if (res.code !== 0) throw new Error(`code ${res.code} ${res.transactionHash}: ${res.rawLog ?? ""}`);
  return res.transactionHash;
}

// ------------------------------------------------------------------ item 2: coin-60 signers

/**
 * Send one EVM tx from a coin-60 signer. On a window/PQC refusal, fix that cause once (register
 * the signer's ML-DSA-87 key, or open a window) and send a new tx. Anything else stops.
 */
async function sendWithPrerequisites(
  ctx: Ctx,
  who: UnifiedAccount,
  send: () => Promise<Hex>,
  windowTargets?: string[],
): Promise<{ steps: SenderStep[]; hash?: Hex }> {
  const steps: SenderStep[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const hash = await send();
      steps.push({ kind: "sent", hash });
      return { steps, hash };
    } catch (err) {
      const rejection = classifyEvmWindowRejection(err);
      if (!rejection) {
        steps.push({ kind: "error", error: errorText(err) });
        return { steps };
      }
      steps.push({ kind: "refused", rejection, error: errorText(err) });
      try {
        if (rejection === "no-pqc-key" && !steps.some((s) => s.kind === "registered-pqc")) {
          const proof = signProofOfPossession({ chainId: ctx.env.network.chainId, account: who.cosmos, keypair: who.pqc, algorithmId: 1 });
          const msg = buildRegisterPqcKeyMsg(who.cosmos, { pqcKeypair: who.pqc, proofOfPossession: proof });
          steps.push({ kind: "registered-pqc", hash: await sendEthNative(ctx, who, "classical", [msg], REGISTER_GAS) });
          continue;
        }
        if ((rejection === "no-window" || rejection === "exhausted") && !steps.some((s) => s.kind === "opened-window")) {
          const msg = openEvmWindowMsg({ sender: who.cosmos, ...SIGNER_WINDOW, ...(windowTargets ? { allowedTargets: windowTargets } : {}) });
          steps.push({ kind: "opened-window", hash: await sendEthNative(ctx, who, "hybrid", [msg], WINDOW_GAS) });
          continue;
        }
      } catch (fixErr) {
        steps.push({ kind: "error", error: errorText(fixErr) });
      }
      return { steps };
    }
  }
  return { steps };
}

function walletFor(ctx: Ctx, account: PrivateKeyAccount) {
  // retryCount 0: a send is never retried.
  return createWalletClient({ account, chain: ctx.chain, transport: http(ctx.env.network.evmRpc, { retryCount: 0 }) });
}

async function receiptOk(ctx: Ctx, hash: Hex): Promise<{ ok: boolean; contractAddress?: Address }> {
  const r = await ctx.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  return { ok: r.status === "success", contractAddress: r.contractAddress ?? undefined };
}

async function fundSigner(ctx: Ctx, ownerTx: TxClient, role: Role, txs: TxRef[], evidence: string[]): Promise<void> {
  const { signer } = ctx.evm[role];
  const wei = await evmBalance(ctx.env.network.evmRpc, signer.address);
  if (wei >= uqorToWei(SIGNER_MIN)) {
    evidence.push(`${role} signer ${signer.address} 已有 ${wei} wei，不補款`);
    return;
  }
  const amount = SIGNER_TOP_UP - wei / uqorToWei(BigInt(1));
  const res = await ownerTx.bankSend(signer.cosmos, [{ denom: "uqor", amount: amount.toString() }]);
  if (res.code !== 0) throw new Error(`funding ${role} signer: code ${res.code}: ${res.rawLog ?? ""}`);
  txs.push({ label: `owner 帳號補款給 ${role} signer`, hash: res.transactionHash, lane: "cosmos" });
}

async function signerState(ctx: Ctx, role: Role): Promise<string> {
  const { signer } = ctx.evm[role];
  clearPqcStatusCache();
  const pqc = await retrying(() => fetchPqcStatus({ rest: ctx.env.network.rest, address: signer.cosmos }));
  const win = await retrying(() => fetchEvmWindow({ rest: ctx.env.network.rest, address: signer.cosmos }));
  return `${role} signer ${signer.address}（${signer.cosmos}）開始時：PQC ${pqc.registered ? "已註冊" : "未註冊"}，window ${win.found ? (win.live ? "開著" : "已過期／用完") : "沒有"}`;
}

async function probeSigners(ctx: Ctx, ownerTx: TxClient, unified: Record<Role, UnifiedAccount>): Promise<void> {
  say("\n[2] coin-60 signers: what does an EVM tx need?");
  const txs: TxRef[] = [];
  const evidence: string[] = [];
  const signers: { role: string; steps: SenderStep[] }[] = [];
  try {
    for (const role of ["owner", "agent"] as const) {
      evidence.push(await signerState(ctx, role));
      await fundSigner(ctx, ownerTx, role, txs, evidence);
    }

    // owner signer deploys ProbeRecorder (contract creation: its window cannot name targets).
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const ownerWallet = walletFor(ctx, privateKeyToAccount(ctx.evm.owner.signer.privateKey));
    const deploy = await sendWithPrerequisites(ctx, unified.owner, () =>
      ownerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, chain: ctx.chain }),
    );
    signers.push({ role: "owner signer（deploy）", steps: deploy.steps });
    evidence.push(...deploy.steps.map((s) => `owner signer：${describeSenderStep(s)}`));
    for (const s of deploy.steps) if (s.kind === "registered-pqc" || s.kind === "opened-window") txs.push({ label: `owner signer ${s.kind}`, hash: s.hash, lane: "cosmos" });
    if (deploy.hash) {
      const r = await receiptOk(ctx, deploy.hash);
      txs.push({ label: "owner signer 部署 ProbeRecorder", hash: deploy.hash, lane: "evm" });
      if (!r.ok || !r.contractAddress) throw new Error(`deploy ${deploy.hash} reverted`);
      ctx.probe = r.contractAddress;
      say(`  ProbeRecorder at ${ctx.probe}`);
    }

    // agent signer calls allowed() directly (the EOA lane, D-11's fallback).
    if (ctx.probe) {
      const probe = ctx.probe;
      const agentWallet = walletFor(ctx, privateKeyToAccount(ctx.evm.agent.signer.privateKey));
      const call = await sendWithPrerequisites(
        ctx,
        unified.agent,
        () => agentWallet.sendTransaction({ to: probe, data: ALLOWED_SELECTOR, chain: ctx.chain }),
        [probe],
      );
      signers.push({ role: "agent signer（呼叫 allowed()）", steps: call.steps });
      evidence.push(...call.steps.map((s) => `agent signer：${describeSenderStep(s)}`));
      for (const s of call.steps) if (s.kind === "registered-pqc" || s.kind === "opened-window") txs.push({ label: `agent signer ${s.kind}`, hash: s.hash, lane: "cosmos" });
      if (call.hash) {
        const r = await receiptOk(ctx, call.hash);
        txs.push({ label: "agent signer 直接呼叫 allowed()（EOA lane）", hash: call.hash, lane: "evm" });
        const sender = await read<Address>(ctx, "lastSender");
        evidence.push(`EOA lane：receipt ${r.ok ? "success" : "reverted"}，msg.sender = ${sender}（agent signer ${ctx.evm.agent.signer.address}）`);
      }
    }
    const j = judgeSenderPrerequisites(signers);
    setItem(ctx, 2, j.verdict, j.summary, evidence, txs);
  } catch (err) {
    evidence.push(`中止：${errorText(err)}`);
    const j = signers.length ? judgeSenderPrerequisites(signers) : { summary: "" };
    setItem(ctx, 2, "inconclusive", `${j.summary} 中止：${errorText(err)}`.trim(), evidence, txs);
  }
}

async function read<T>(ctx: Ctx, functionName: "lastSender" | "lastValue" | "lastSelector" | "calls"): Promise<T> {
  const probe = ctx.probe as Address;
  return retrying(() => ctx.pub.readContract({ address: probe, abi: PROBE_ABI, functionName })) as Promise<T>;
}

// ------------------------------------------------------------------ items 1, 3, 4: authenticator lane

/** An EIP-1193 provider backed by the local agent key, just for the SDK's personal_sign. */
function localProvider(account: PrivateKeyAccount) {
  return {
    async request({ method, params }: { method: string; params: unknown[] }): Promise<string> {
      if (method !== "personal_sign") throw new Error(`unsupported ${method}`);
      return account.signMessage({ message: { raw: params[0] as Hex } });
    },
  };
}

/** One MsgExecuteEVM: agent key authorises, agent's qor1 relays and pays. Broadcast once. */
async function execute(
  ctx: Ctx,
  agentTx: TxClient,
  fn: "allowed" | "blocked",
  valueWei: bigint,
): Promise<{ outcome: ExecOutcome; windowRejection?: string }> {
  const owner = ctx.roles.owner.address;
  const agentSigner = ctx.evm.agent.signer;
  const rest = ctx.env.network.rest;
  try {
    const { nonce } = await retrying(() => fetchAuthNonce({ rest, address: owner, pubkey: agentSigner.address }));
    const digestVersion = await retrying(() => resolveEvmAuthDigestVersion({ rest }));
    const msg = await buildMetaMaskExecuteEvm({
      provider: localProvider(privateKeyToAccount(agentSigner.privateKey)),
      address: agentSigner.address,
      relayer: ctx.roles.agent.address,
      chainId: ctx.env.network.chainId,
      account: owner,
      to: ctx.probe as string,
      value: valueWei.toString(),
      data: hexToBytes(fn === "allowed" ? ALLOWED_SELECTOR : BLOCKED_SELECTOR),
      gasLimit: EXEC_GAS_LIMIT,
      nonce,
      digestVersion,
    });
    // Simulate first: a refusal here means nothing was broadcast.
    try {
      await agentTx.simulate([msg]);
    } catch (err) {
      return { outcome: { kind: "refused", error: `simulation: ${errorText(err)}` }, windowRejection: classifyEvmWindowRejection(err) };
    }
    let res;
    try {
      res = await agentTx.signAndBroadcast([msg], "auto");
    } catch (err) {
      // A typed non-zero code (CheckTx or delivery) is a refusal; anything else may have landed.
      if (err instanceof QoreTxError) {
        return {
          outcome: { kind: "refused", code: err.code, codespace: err.codespace, error: errorText(err), hash: err.txHash },
          windowRejection: classifyEvmWindowRejection(err),
        };
      }
      return { outcome: { kind: "error", error: errorText(err) } };
    }
    if (res.code !== 0) {
      return {
        outcome: { kind: "refused", code: res.code, error: res.rawLog ?? "", hash: res.transactionHash },
        windowRejection: classifyEvmWindowRejection({ code: res.code, rawLog: res.rawLog }),
      };
    }
    try {
      assertAuthenticatorExecutionsSucceeded(res, [msg]);
    } catch (err) {
      if (err instanceof AuthenticatorExecutionError) {
        const reason = err.failed.map((f) => f.reason || f.vmError).join("; ");
        return { outcome: { kind: "execution-failed", hash: res.transactionHash, reason }, windowRejection: classifyEvmWindowRejection(reason) };
      }
      throw err;
    }
    return { outcome: { kind: "success", hash: res.transactionHash } };
  } catch (err) {
    return { outcome: { kind: "error", error: errorText(err) } };
  }
}

function execTx(label: string, o: ExecOutcome): TxRef[] {
  const hash = "hash" in o ? o.hash : undefined;
  return hash ? [{ label, hash, lane: "cosmos" }] : [];
}

async function probeAuthenticatorLane(ctx: Ctx, ownerTx: TxClient, agentTx: TxClient): Promise<void> {
  say("\n[1][3][4] MsgExecuteEVM through the Linked agent key");
  if (!ctx.probe) {
    for (const id of [1, 3, 4] as const) setItem(ctx, id, "inconclusive", "沒有探測合約（部署沒成功，見第 2 項）。", [], []);
    return;
  }
  const probe = ctx.probe;
  const rest = ctx.env.network.rest;
  const owner = ctx.roles.owner.address;
  const ownerEvm = ctx.evm.owner.account.evm;
  const agentSigner = ctx.evm.agent.signer;
  const valueWei = uqorToWei(EXEC_VALUE_UQOR);
  const ev1: string[] = [];
  const ev3: string[] = [];
  const ev4: string[] = [];
  const tx1: TxRef[] = [];
  const tx3: TxRef[] = [];
  const tx4: TxRef[] = [];
  let openedWindow = false;

  try {
    // A clean start for item 4: no window on the owner account.
    const before = await retrying(() => fetchEvmWindow({ rest, address: owner }));
    if (before.found && before.live) {
      const h = await ownerBroadcast(ownerTx, [closeEvmWindowMsg(owner)]);
      tx4.push({ label: "關掉 owner 帳號原本的 window", hash: h, lane: "cosmos" });
    }

    // Link the agent's coin-60 key by its 20-byte address, with a rule that allows only allowed().
    const links = await retrying(() => fetchAuthenticators({ rest, address: owner }));
    const pubkeyHex = agentSigner.address.slice(2).toLowerCase();
    const linked = links.some((a) => a.pubkeyHex.toLowerCase().replace(/^0x/, "") === pubkeyHex && !a.revoked);
    const proof = signAuthenticatorLinkEip191({ chainId: ctx.env.network.chainId, account: owner, privateKey: agentSigner.privateKey });
    const rule = allowedEvmCall(probe, ALLOWED_SELECTOR);
    const msgs = linkAuthenticatorMsgs({
      owner,
      chainId: ctx.env.network.chainId,
      scheme: "secp256k1",
      pubkey: hexToBytes(agentSigner.address),
      permissions: ["evm"],
      expiryUnix: Math.floor(Date.now() / 1000) + 2 * 3600,
      label: "flygate-live-probe",
      possessionProof: proof.possessionProof,
      spendingRule: { id: "flygate-live-probe", perTxLimit: "10000", dailyLimit: "50000", enabled: true, allowedEvmCalls: [rule] },
    });
    const toSend = linked ? msgs.filter((m) => !/RegisterAuthenticator/.test(m.typeUrl)) : msgs;
    const linkHash = await ownerBroadcast(ownerTx, toSend);
    ev3.push(`支出規則 allowedEvmCalls = ["${rule}"]（只放行 allowed()）${linked ? "；agent 金鑰已綁定過，只更新規則" : ""}`);
    tx3.push({ label: linked ? "MsgUpdateSpendingRules" : "linkAuthenticatorMsgs（規則 + 綁定）", hash: linkHash, lane: "cosmos" });

    // allowed() with no window on the owner account.
    const callsBefore = await read<bigint>(ctx, "calls");
    const balBefore = await evmBalance(ctx.env.network.evmRpc, ownerEvm);
    let first = await execute(ctx, agentTx, "allowed", valueWei);
    ev4.push(`沒開 window：allowed() ${describeExec(first.outcome)}`);
    tx4.push(...execTx("MsgExecuteEVM allowed()（沒開 window）", first.outcome));
    const withoutWindow = first.outcome;
    const windowRejection = first.windowRejection;

    if (first.outcome.kind === "refused" && windowRejection) {
      // A window is required: open one that admits the probe, then call again (a new tx).
      const h = await ownerBroadcast(ownerTx, [
        openEvmWindowMsg({ sender: owner, blocks: 600, maxTxs: 3, maxValue: "100000", allowedTargets: [probe] }),
      ]);
      openedWindow = true;
      tx4.push({ label: "owner 帳號開 window（allowedTargets = 探測合約）", hash: h, lane: "cosmos" });
      first = await execute(ctx, agentTx, "allowed", valueWei);
      ev4.push(`開 window 後：allowed() ${describeExec(first.outcome)}`);
      tx4.push(...execTx("MsgExecuteEVM allowed()（window 內）", first.outcome));
    }

    // Item 1 from the successful allowed().
    const executed = first.outcome.kind === "success";
    const recordedSender = executed ? await read<Address>(ctx, "lastSender") : undefined;
    const recordedValueWei = executed ? await read<bigint>(ctx, "lastValue") : undefined;
    const balAfter = await evmBalance(ctx.env.network.evmRpc, ownerEvm);
    const j1 = judgeExecuteSender({
      executed,
      recordedSender,
      recordedValueWei,
      ownerAccountEvm: ownerEvm,
      agentSigner: agentSigner.address,
      sentValueWei: valueWei,
      ownerDropWei: balBefore - balAfter,
    });
    ev1.push(`owner 帳號 ${owner} = ${ownerEvm}；agent signer ${agentSigner.address}；relayer ${ctx.roles.agent.address}`);
    ev1.push(`ProbeRecorder：lastSender = ${recordedSender}，lastValue = ${recordedValueWei}；owner 帳號 EVM 餘額 ${balBefore} → ${balAfter} wei`);
    setItem(ctx, 1, j1.verdict, j1.summary, ev1, [...tx1, ...execTx("MsgExecuteEVM allowed()", first.outcome)]);

    // Item 3: blocked() under the same rule (and, if one is open, a window that admits the probe).
    const callsMid = await read<bigint>(ctx, "calls");
    const blocked = await execute(ctx, agentTx, "blocked", BigInt(0));
    const callsAfter = await read<bigint>(ctx, "calls");
    ev3.push(`allowed()：${describeExec(first.outcome)}`, `blocked()：${describeExec(blocked.outcome)}`);
    ev3.push(`ProbeRecorder.calls：${callsBefore} → ${callsMid}（allowed 之後）→ ${callsAfter}（blocked 之後）`);
    tx3.push(...execTx("MsgExecuteEVM blocked()", blocked.outcome));
    const j3 = judgeSelectorRule({ allowed: first.outcome, blocked: blocked.outcome, callsBefore: callsMid, callsAfter });
    setItem(ctx, 3, j3.verdict, j3.summary, ev3, tx3);

    // Item 4, second half: when no window was needed, does a window scoped elsewhere stop it?
    let outsideScope: ExecOutcome | undefined;
    if (withoutWindow.kind === "success") {
      const h = await ownerBroadcast(ownerTx, [
        openEvmWindowMsg({ sender: owner, blocks: 600, maxTxs: 3, maxValue: "100000", allowedTargets: [DECOY_TARGET] }),
      ]);
      openedWindow = true;
      tx4.push({ label: `owner 帳號開 window（allowedTargets = ${DECOY_TARGET}）`, hash: h, lane: "cosmos" });
      const scoped = await execute(ctx, agentTx, "allowed", valueWei);
      outsideScope = scoped.outcome;
      ev4.push(`window 只放行 ${DECOY_TARGET}：allowed() ${describeExec(scoped.outcome)}`);
      tx4.push(...execTx("MsgExecuteEVM allowed()（window 不含探測合約）", scoped.outcome));
    }
    const j4 = judgeWindowGovernsExecute({ withoutWindow, outsideScope, windowRejection });
    setItem(ctx, 4, j4.verdict, j4.summary, ev4, tx4);
  } catch (err) {
    const why = `中止：${errorText(err)}`;
    for (const [id, ev, txs] of [[1, ev1, tx1], [3, ev3, tx3], [4, ev4, tx4]] as const) {
      if (!ctx.items.has(id)) setItem(ctx, id, "inconclusive", why, [...ev, why], [...txs]);
    }
  } finally {
    if (openedWindow) {
      try {
        const h = await ownerBroadcast(ownerTx, [closeEvmWindowMsg(owner)]);
        say(`  closed the owner account's probe window: ${h}`);
      } catch (err) {
        say(`  could not close the owner account's probe window (it expires on its own): ${errorText(err)}`);
      }
    }
  }
}

// ------------------------------------------------------------------ item 6: merchant signature (reads only)

async function probePqcVerify(ctx: Ctx): Promise<void> {
  say("\n[6] merchant ML-DSA-87 signature vs the on-chain key");
  const merchant = ctx.roles.merchant; // pqcKeypair = derivePqcCanonical(merchant qor1, MERCHANT_MNEMONIC)
  const evidence: string[] = [];
  try {
    const status = await pqcKeyStatusOnEvm(ctx.env.network.evmRpc, ctx.evm.merchant.account.evm);
    const onchain = bytesToHex(status.pubkey);
    const pubkeyMatches = onchain === bytesToHex(merchant.pqcKeypair.publicKey);
    const escrow = (process.env.FLIGHT_ESCROW_ADDRESS as Address | undefined) || ctx.probe || zeroAddress;
    const quote: Quote = {
      merchant: ctx.evm.merchant.account.evm,
      agent: ctx.evm.owner.account.evm,
      offerId: keccak256(stringToBytes("live-probe")),
      priceWei: uqorToWei(BigInt(3_890_000)),
      origin: "TPE",
      destination: "TYO",
      departDay: Math.floor(Date.UTC(2026, 11, 20) / 86_400_000),
      cabin: Cabin.Economy,
      refundable: true,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 1200),
      ticketWindow: 600,
    };
    const message = quoteMessage(quote, { chainId: DIANA_CHAIN_ID, escrow });
    const signature = signMessage(message, merchant.pqcKeypair.secretKey);
    const local = verifyMessage(onchain, signature, message);
    const call = async (sig: Hex): Promise<boolean> => {
      try {
        const ret = await retrying(() =>
          ctx.pub.call({
            to: PQC_VERIFY_ADDRESS,
            data: encodeFunctionData({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", args: [onchain, sig, bytesToHex(message)] }),
          }),
        );
        return decodeFunctionResult({ abi: PQC_VERIFY_ABI, functionName: "pqcVerify", data: ret.data ?? "0x" });
      } catch (err) {
        evidence.push(`pqcVerify eth_call reverted：${errorText(err)}`);
        return false;
      }
    };
    const precompile = await call(signature);
    const last = signature.slice(-2);
    const tampered = (signature.slice(0, -2) + (last === "00" ? "01" : "00")) as Hex;
    const precompileTampered = await call(tampered);
    evidence.push(
      `商家 ${merchant.address} = ${ctx.evm.merchant.account.evm}：pqcKeyStatus registered ${status.registered}、algorithmId ${status.algorithmId}、possessionProven ${status.possessionProven}`,
      `簽的是 quoteMessage（domain：chainId ${DIANA_CHAIN_ID}、escrow ${escrow}），簽章 ${(signature.length - 2) / 2} bytes`,
      "全部是 eth_call，沒有廣播",
    );
    const j = judgePqcVerify({ pubkeyMatches, local, precompile, precompileTampered });
    setItem(ctx, 6, j.verdict, j.summary, evidence, []);
  } catch (err) {
    const j = judgePqcVerify({ pubkeyMatches: false, local: false, error: errorText(err) });
    setItem(ctx, 6, j.verdict, j.summary, evidence, []);
  }
}

// ------------------------------------------------------------------ item 5: explorer

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

async function probeExplorer(ctx: Ctx, prompt: boolean): Promise<void> {
  say("\n[5] explorer and 0x EVM hashes");
  const all = [...ctx.items.values()].flatMap((i) => i.txs);
  const evm = all.find((t) => t.lane === "evm");
  const cosmos = all.find((t) => t.lane === "cosmos");
  const txs = [evm, cosmos].filter((t): t is TxRef => !!t);
  let answer: "y" | "n" | undefined;
  if (evm && prompt && process.stdin.isTTY) {
    say(`  Open (switch the explorer to Testnet first): ${explorerTxUrl(ctx.env.network.explorer, evm.hash)}`);
    if (cosmos) say(`  For comparison, a Cosmos tx: ${explorerTxUrl(ctx.env.network.explorer, cosmos.hash)}`);
    const a = await ask("  Does the explorer show the 0x EVM transaction? [y/n/skip] ");
    if (a === "y" || a === "n") answer = a;
  }
  const j = judgeExplorer({ evmHash: evm?.hash, answer });
  setItem(ctx, 5, j.verdict, j.summary, ["explorer 依 cookie 選主網／測試網（預設主網），要先切到 Testnet"], txs);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((a) => a !== "--");
  const unknown = flags.filter((f) => f !== "--yes" && f !== "--no-prompt");
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Usage: pnpm live:probe [--yes] [--no-prompt]`);

  const env = readProbeEnvFrom(ENV_PATH);
  const roles = {} as Record<Role, RoleAccount>;
  const evm = {} as Record<Role, EvmRole>;
  const unified = {} as Record<Role, UnifiedAccount>;
  for (const role of ROLES) {
    roles[role] = await deriveRole(role, env.mnemonics[role]);
    evm[role] = await deriveEvmRole(role, env.mnemonics[role]);
    unified[role] = await deriveUnifiedAccount(env.mnemonics[role]);
    if (unified[role].evm.toLowerCase() !== evm[role].signer.address.toLowerCase()) {
      throw new Error(`${role}: the unified eth-native account is not the coin-60 signer. Nothing sent.`);
    }
  }
  SECRETS = [
    ...ROLES.map((r) => env.mnemonics[r]),
    ...ROLES.map((r) => evm[r].signer.privateKey),
    ...ROLES.map((r) => unified[r].privateKey),
    ...ROLES.map((r) => bytesToHex(roles[r].account.privateKey)),
  ];

  const chain = defineChain({
    id: DIANA_EVM_CHAIN_ID,
    name: "qorechain-diana",
    nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
    rpcUrls: { default: { http: [env.network.evmRpc] } },
  });
  const ctx: Ctx = {
    env,
    client: makeClient(env.network),
    pub: createPublicClient({ chain, transport: http(env.network.evmRpc) }) as PublicClient,
    chain,
    roles,
    evm,
    items: new Map(),
  };

  const chainId = await evmChainId(env.network.evmRpc);
  if (chainId !== DIANA_EVM_CHAIN_ID) throw new Error(`EVM chain id is ${chainId}, expected ${DIANA_EVM_CHAIN_ID} (diana). Nothing sent.`);

  say(`live:probe on ${env.network.chainId} (EVM ${chainId}), @qorechain/sdk ${VERSION}`);
  for (const role of ROLES) say(`  ${role.padEnd(8)} account ${roles[role].address} / ${evm[role].account.evm}   signer ${evm[role].signer.address}`);
  say("\nThis sends real diana transactions from these accounts: signer top-ups (up to 3 QOR each),");
  say("a ProbeRecorder deploy, the signers' PQC registration and windows if diana asks for them,");
  say("a spending rule + agent key link on the owner account, and a few 0.001 QOR MsgExecuteEVM calls.");
  say("It replaces the owner account's spending rules (the /mandate step rewrites them later).");
  if (!flags.includes("--yes")) {
    if (!process.stdin.isTTY) throw new Error("Not a terminal: pass --yes to confirm. Nothing sent.");
    if ((await ask("Continue? [y/N] ")) !== "y") {
      say("Nothing sent.");
      return;
    }
  }

  const ownerTx = await connect(ctx.client, roles.owner);
  const agentTx = await connect(ctx.client, roles.agent);

  await probeSigners(ctx, ownerTx, unified);
  await probeAuthenticatorLane(ctx, ownerTx, agentTx);
  await probePqcVerify(ctx);
  await probeExplorer(ctx, !flags.includes("--no-prompt"));

  const run = {
    date: new Date().toISOString().slice(0, 10),
    sdkVersion: VERSION,
    chainId: env.network.chainId,
    explorer: env.network.explorer,
    probeAddress: ctx.probe,
    items: [...ctx.items.values()],
  };
  const record = renderRecord(run);
  assertNoSecrets(record, SECRETS);
  writeFileSync(FLOW_PATH, replaceRecord(readFileSync(FLOW_PATH, "utf8"), record));
  say("\n" + record);
  say(`\nWrote the record into ${FLOW_PATH}.`);

  const comment = renderIssueComment(run);
  if (comment) {
    assertNoSecrets(comment, SECRETS);
    const path = join(tmpdir(), "flygate-live-probe-issue-16.md");
    writeFileSync(path, comment + "\n");
    say(`\nDecisions overturned or amended. Review, then post:\n  gh issue comment 16 --body-file ${path}`);
  } else {
    say("\nNo decision overturned by the conclusive items.");
  }
}

main().catch((err: unknown) => {
  const text = errorText(err);
  try {
    assertNoSecrets(text, SECRETS);
    console.error(`\nlive:probe failed: ${text}`);
  } catch {
    console.error("\nlive:probe failed (the error text held key material and was withheld).");
  }
  process.exit(1);
});
