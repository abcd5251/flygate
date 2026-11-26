// Pure parts of `pnpm live:probe`: env reading, amounts, verdict rules, the FLOW.md record
// and the #16 comment. Nothing here touches the network, so it is unit-tested offline.
import { existsSync, readFileSync } from "node:fs";
import { NETWORK_DEFAULTS, ROLES, type NetworkSettings, type Role } from "../bootstrap/env";

export type Hex = `0x${string}`;

// ------------------------------------------------------------------ env (read-only)

export const MNEMONIC_KEYS: Record<Role, string> = {
  owner: "OWNER_MNEMONIC",
  agent: "AGENT_MNEMONIC",
  merchant: "MERCHANT_MNEMONIC",
};

export interface ProbeEnv {
  network: NetworkSettings;
  /** Secrets: never print, log or write these. */
  mnemonics: Record<Role, string>;
}

/** KEY=value lines; `#` comments and blank lines skipped; one layer of quotes removed. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * The three mnemonics and the network settings, from the process env first and then the
 * env file's text. Unlike `pnpm bootstrap`, this never generates or writes anything: a
 * missing mnemonic is an error that names the variable (never a value).
 */
export function readProbeEnv(env: Record<string, string | undefined>, fileText = ""): ProbeEnv {
  const file = parseEnvText(fileText);
  const get = (key: string): string | undefined => env[key] || file[key] || undefined;
  const missing = ROLES.map((r) => MNEMONIC_KEYS[r]).filter((k) => !get(k));
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")}. Set them in the server env or .env.local (run \`pnpm bootstrap\`).`);
  }
  const mnemonics = {} as Record<Role, string>;
  for (const role of ROLES) mnemonics[role] = get(MNEMONIC_KEYS[role]) as string;
  return {
    network: {
      chainId: get("QORE_CHAIN_ID") ?? NETWORK_DEFAULTS.QORE_CHAIN_ID,
      rpc: get("QORE_RPC_URL") ?? NETWORK_DEFAULTS.QORE_RPC_URL,
      rest: get("QORE_REST_URL") ?? NETWORK_DEFAULTS.QORE_REST_URL,
      evmRpc: get("QORE_EVM_RPC_URL") ?? NETWORK_DEFAULTS.QORE_EVM_RPC_URL,
      explorer: (get("QORE_EXPLORER_URL") ?? NETWORK_DEFAULTS.QORE_EXPLORER_URL).replace(/\/+$/, ""),
    },
    mnemonics,
  };
}

/** Read-only: the file is only read when it exists. */
export function readProbeEnvFrom(path: string, env: Record<string, string | undefined> = process.env): ProbeEnv {
  return readProbeEnv(env, existsSync(path) ? readFileSync(path, "utf8") : "");
}

/**
 * Throw when `text` contains any secret (a whole mnemonic, any 12+ word run of one, or a
 * private key). Every line the probe prints or writes goes through this first.
 */
export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  const lower = text.toLowerCase();
  for (const secret of secrets) {
    const s = secret.trim().toLowerCase();
    if (!s) continue;
    if (lower.includes(s) || lower.includes(s.replace(/^0x/, ""))) {
      throw new Error("Refusing to output text that contains key material.");
    }
    const words = s.split(/\s+/);
    if (words.length >= 12) {
      for (let i = 0; i + 12 <= words.length; i++) {
        if (lower.includes(words.slice(i, i + 12).join(" "))) {
          throw new Error("Refusing to output text that contains key material.");
        }
      }
    }
  }
}

// ------------------------------------------------------------------ amounts and rules

/** 1 uqor (6 decimals, bank) = 1e12 wei (18 decimals, EVM). */
export const WEI_PER_UQOR = BigInt(1_000_000_000_000);
export const uqorToWei = (uqor: bigint): bigint => uqor * WEI_PER_UQOR;
export const weiToUqorCeil = (wei: bigint): bigint => (wei + WEI_PER_UQOR - BigInt(1)) / WEI_PER_UQOR;

/** `0x<target>/0x<selector>`, lowercase: the form `SpendingRule.allowedEvmCalls` takes. */
export function allowedEvmCall(target: string, selector: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error(`Not a 20-byte hex address: ${target}`);
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new Error(`Not a 4-byte selector: ${selector}`);
  return `${target.toLowerCase()}/${selector.toLowerCase()}`;
}

/** Fee in uqor for an explicit gas limit, rounded up (gas price in uqor per gas, e.g. "0.15"). */
export function feeUqor(gas: number, gasPriceUqor: string): bigint {
  const [whole, frac = ""] = gasPriceUqor.split(".");
  const scale = BigInt(10) ** BigInt(frac.length);
  const priceScaled = BigInt(whole || "0") * scale + BigInt(frac || "0");
  const total = BigInt(gas) * priceScaled;
  return (total + scale - BigInt(1)) / scale;
}

export const explorerTxUrl = (explorer: string, hash: string) => `${explorer}/tx/${hash}`;

/** The first lines of an error, for the record. Never includes request bodies. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n").slice(0, 3).join(" ").slice(0, 400);
}

// ------------------------------------------------------------------ results

export type Verdict = "holds" | "fails" | "inconclusive";
export type ItemId = 1 | 2 | 3 | 4 | 5 | 6;

export interface TxRef {
  label: string;
  hash: string;
  lane: "cosmos" | "evm";
}

export interface ItemResult {
  id: ItemId;
  verdict: Verdict;
  /** One-paragraph conclusion. */
  summary: string;
  /** Observations, refusals and error codes, in order. */
  evidence: string[];
  txs: TxRef[];
}

export const ITEM_TITLES: Record<ItemId, string> = {
  1: "MsgExecuteEVM（Linked agent key）的 msg.sender 是 owner 帳號 0x，msg.value 從 owner 帳號出",
  2: "coin-60 signer 送一般 EVM 交易的前置條件（PQC 註冊、Scoped window）",
  3: "帶 selector 的 allowedEvmCalls 放行指定函式、擋下其他函式",
  4: "window 管得到 MsgExecuteEVM",
  5: "explorer 認 0x EVM 交易雜湊",
  6: "derivePqcCanonical 商家金鑰經共用 escrow 模組簽的 ML-DSA-87 簽章能被鏈上公鑰驗過",
};

/** Item 1: what ProbeRecorder recorded for one MsgExecuteEVM, and the owner's balance change. */
export function judgeExecuteSender(o: {
  executed: boolean;
  recordedSender?: string;
  recordedValueWei?: bigint;
  ownerAccountEvm: string;
  agentSigner: string;
  sentValueWei: bigint;
  ownerDropWei?: bigint;
}): { verdict: Verdict; summary: string } {
  if (!o.executed || o.recordedSender === undefined) {
    return { verdict: "inconclusive", summary: "MsgExecuteEVM 沒有成功執行，讀不到 msg.sender。" };
  }
  const sender = o.recordedSender.toLowerCase();
  const valueOk = o.recordedValueWei === o.sentValueWei;
  const paidByOwner = o.ownerDropWei !== undefined && o.ownerDropWei >= o.sentValueWei;
  if (sender === o.ownerAccountEvm.toLowerCase() && valueOk && paidByOwner) {
    return {
      verdict: "holds",
      summary: `msg.sender = owner 帳號 ${o.ownerAccountEvm}，msg.value = ${o.sentValueWei} wei，owner 帳號餘額少了 ${o.ownerDropWei} wei。`,
    };
  }
  const who =
    sender === o.agentSigner.toLowerCase() ? `agent 的 coin-60 地址 ${o.agentSigner}` : o.recordedSender;
  return {
    verdict: "fails",
    summary:
      `msg.sender = ${who}` +
      `${valueOk ? "" : `，msg.value = ${o.recordedValueWei} wei（送出 ${o.sentValueWei}）`}` +
      `${paidByOwner ? "" : `，owner 帳號餘額變化 ${o.ownerDropWei ?? "未知"} wei`}。`,
  };
}

/** What sending one EVM tx from a coin-60 signer ran into, step by step. */
export type SenderStep =
  | { kind: "sent"; hash: string }
  | { kind: "refused"; rejection: string; error: string }
  | { kind: "error"; error: string }
  | { kind: "registered-pqc"; hash: string }
  | { kind: "opened-window"; hash: string };

/** Item 2: the prerequisites a coin-60 signer needed before its EVM tx was admitted. */
export function judgeSenderPrerequisites(signers: { role: string; steps: SenderStep[] }[]): {
  verdict: Verdict;
  summary: string;
} {
  const parts: string[] = [];
  let allSent = true;
  for (const { role, steps } of signers) {
    const sent = steps.some((s) => s.kind === "sent");
    allSent &&= sent;
    const needed: string[] = [];
    if (steps.some((s) => s.kind === "registered-pqc")) needed.push("PQC 註冊");
    if (steps.some((s) => s.kind === "opened-window")) needed.push("window");
    const refusals = steps
      .filter((s): s is Extract<SenderStep, { kind: "refused" }> => s.kind === "refused")
      .map((s) => s.rejection);
    if (!sent) {
      const last = steps[steps.length - 1];
      parts.push(`${role}：沒送成功（${last ? describeStep(last) : "沒有嘗試"}）`);
    } else if (needed.length === 0) {
      parts.push(`${role}：不需前置條件，第一次就被接受`);
    } else {
      parts.push(`${role}：需要 ${needed.join(" + ")}（依序被拒：${refusals.join(" → ") || "無"}）`);
    }
  }
  return { verdict: allSent ? "holds" : "inconclusive", summary: parts.join("；") + "。" };
}

function describeStep(s: SenderStep): string {
  switch (s.kind) {
    case "sent":
      return `送出 ${s.hash}`;
    case "refused":
      return `被拒 ${s.rejection}：${s.error}`;
    case "error":
      return `錯誤：${s.error}`;
    case "registered-pqc":
      return `註冊 PQC ${s.hash}`;
    case "opened-window":
      return `開 window ${s.hash}`;
  }
}
export const describeSenderStep = describeStep;

/** Outcome of one MsgExecuteEVM attempt. */
export type ExecOutcome =
  | { kind: "success"; hash: string }
  | { kind: "execution-failed"; hash: string; reason: string }
  | { kind: "refused"; code?: number; codespace?: string; error: string; hash?: string }
  | { kind: "error"; error: string };

export function describeExec(o: ExecOutcome): string {
  switch (o.kind) {
    case "success":
      return `成功 ${o.hash}`;
    case "execution-failed":
      return `code 0 但執行失敗（${o.reason}）${o.hash}`;
    case "refused":
      return `被拒${o.codespace ? ` ${o.codespace}` : ""}${o.code !== undefined ? ` code ${o.code}` : ""}：${o.error}`;
    case "error":
      return `錯誤（沒有重送）：${o.error}`;
  }
}

/** Item 3: allowed() through, blocked() refused, and the recorder's call count agrees. */
export function judgeSelectorRule(o: {
  allowed: ExecOutcome;
  blocked: ExecOutcome;
  callsBefore?: bigint;
  callsAfter?: bigint;
}): { verdict: Verdict; summary: string } {
  if (o.allowed.kind !== "success") {
    return { verdict: "inconclusive", summary: `allowed() 本身沒過（${describeExec(o.allowed)}），無法判斷 selector 規則。` };
  }
  if (o.blocked.kind === "success") {
    return { verdict: "fails", summary: `blocked() 也被執行了（${o.blocked.hash}）：selector 規則沒有擋下未列出的函式。` };
  }
  if (o.blocked.kind === "error") {
    return { verdict: "inconclusive", summary: `blocked() 的結果不明（${o.blocked.error}）。` };
  }
  const unchanged = o.callsBefore !== undefined && o.callsAfter === o.callsBefore;
  return {
    verdict: unchanged ? "holds" : "inconclusive",
    summary:
      `allowed() 成功，blocked() ${describeExec(o.blocked)}` +
      (unchanged ? "；ProbeRecorder.calls 沒有增加。" : `；calls ${o.callsBefore} → ${o.callsAfter}，需人工確認。`),
  };
}

/**
 * Item 4: does an account's window govern MsgExecuteEVM? `withoutWindow` ran with no window
 * open on the owner account; `outsideScope` ran with a window narrowed to a decoy target.
 * "holds" means the window does govern it.
 */
export function judgeWindowGovernsExecute(o: {
  withoutWindow: ExecOutcome;
  outsideScope?: ExecOutcome;
  windowRejection?: string;
}): { verdict: Verdict; summary: string } {
  if (o.withoutWindow.kind === "refused" && o.windowRejection) {
    return {
      verdict: "holds",
      summary: `owner 帳號沒開 window 時 MsgExecuteEVM 被拒（${o.windowRejection}）：window 管得到 authenticator lane。`,
    };
  }
  if (o.withoutWindow.kind !== "success") {
    return { verdict: "inconclusive", summary: `沒開 window 時的結果：${describeExec(o.withoutWindow)}。` };
  }
  if (!o.outsideScope) {
    return { verdict: "fails", summary: "沒開 window 時 MsgExecuteEVM 照樣執行；沒有測到 scope。" };
  }
  if (o.outsideScope.kind === "success") {
    return {
      verdict: "fails",
      summary: "沒開 window、以及 window 只放行別的地址時，MsgExecuteEVM 都照樣執行：window 管不到 authenticator lane。",
    };
  }
  return {
    verdict: "inconclusive",
    summary: `沒開 window 時可執行，但 window 只放行別的地址時：${describeExec(o.outsideScope)}。需人工判斷。`,
  };
}

/**
 * Item 5: the explorer is a client-rendered app (it picks mainnet/testnet from a cookie), so
 * an HTTP fetch cannot tell "found" from "not found". The person running the probe opens the
 * link and answers; without an answer the item stays inconclusive.
 */
export function judgeExplorer(o: { evmHash?: string; answer?: "y" | "n" }): { verdict: Verdict; summary: string } {
  if (!o.evmHash) return { verdict: "inconclusive", summary: "這次沒有成功的 0x EVM 交易可以查。" };
  if (o.answer === "y") return { verdict: "holds", summary: `explorer 的 /tx/${o.evmHash} 顯示得出這筆 EVM 交易（人工確認，已切到 Testnet）。` };
  if (o.answer === "n") return { verdict: "fails", summary: `explorer 的 /tx/${o.evmHash} 查不到這筆 EVM 交易（人工確認，已切到 Testnet）。` };
  return { verdict: "inconclusive", summary: "沒有人工確認：打開下方 EVM 連結（切到 Testnet）後重跑或手動補上結論。" };
}

/** Item 6: local verify, precompile verify, and a tampered-signature negative control. */
export function judgePqcVerify(o: {
  pubkeyMatches: boolean;
  local: boolean;
  precompile?: boolean;
  precompileTampered?: boolean;
  error?: string;
}): { verdict: Verdict; summary: string } {
  if (o.error) return { verdict: "inconclusive", summary: `讀取失敗：${o.error}` };
  const ok = o.pubkeyMatches && o.local && o.precompile === true && o.precompileTampered === false;
  const facts =
    `鏈上公鑰${o.pubkeyMatches ? "等於" : "不等於"} derivePqcCanonical；verifyMessage = ${o.local}；` +
    `pqcVerify eth_call = ${o.precompile}；竄改過的簽章 pqcVerify = ${o.precompileTampered}。`;
  return { verdict: ok ? "holds" : "fails", summary: facts };
}

// ------------------------------------------------------------------ the record

export const RECORD_START = "<!-- live:probe:start -->";
export const RECORD_END = "<!-- live:probe:end -->";

const VERDICT_LABEL: Record<Verdict, string> = { holds: "成立", fails: "不成立", inconclusive: "未定（見證據）" };

export interface ProbeRun {
  date: string;
  sdkVersion: string;
  chainId: string;
  explorer: string;
  probeAddress?: string;
  items: ItemResult[];
}

/** The Markdown that goes between the record markers in docs/FLOW.md. */
export function renderRecord(run: ProbeRun): string {
  const lines: string[] = [];
  lines.push(`**live:probe（${run.date}，\`@qorechain/sdk@${run.sdkVersion}\`，${run.chainId}）**`);
  lines.push("");
  if (run.probeAddress) lines.push(`探測合約 ProbeRecorder：\`${run.probeAddress}\``, "");
  lines.push("| # | 項目 | 結論 | 摘要 |", "|---|---|---|---|");
  for (const it of [...run.items].sort((a, b) => a.id - b.id)) {
    lines.push(`| ${it.id} | ${ITEM_TITLES[it.id]} | ${VERDICT_LABEL[it.verdict]} | ${cell(it.summary)} |`);
  }
  for (const it of [...run.items].sort((a, b) => a.id - b.id)) {
    lines.push("", `${it.id}. ${ITEM_TITLES[it.id]}：**${VERDICT_LABEL[it.verdict]}**`);
    for (const e of it.evidence) lines.push(`   - ${e}`);
    for (const t of it.txs) {
      lines.push(`   - ${t.label}（${t.lane === "evm" ? "EVM 0x" : "Cosmos"}）：[\`${t.hash}\`](${explorerTxUrl(run.explorer, t.hash)})`);
    }
  }
  return lines.join("\n");
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Replace what is between the markers (exclusive), or fail when they are missing. */
export function replaceRecord(doc: string, record: string): string {
  const start = doc.indexOf(RECORD_START);
  const end = doc.indexOf(RECORD_END);
  if (start < 0 || end < start) throw new Error(`docs/FLOW.md has no ${RECORD_START} … ${RECORD_END} block`);
  return doc.slice(0, start + RECORD_START.length) + "\n" + record + "\n" + doc.slice(end);
}

// ------------------------------------------------------------------ decisions affected

export interface DecisionImpact {
  decisions: string[];
  finding: string;
  proposal: string;
}

/** Which decisions a run overturns or amends, and what to do instead. */
export function decisionImpacts(items: ItemResult[]): DecisionImpact[] {
  const v = (id: ItemId) => items.find((i) => i.id === id)?.verdict;
  const out: DecisionImpact[] = [];
  if (v(1) === "fails") {
    out.push({
      decisions: ["D-09", "D-10", "ADR-0002"],
      finding: "MsgExecuteEVM 的 msg.sender／付款人不是 owner 帳號 0x。",
      proposal: "book() 退回 EOA lane（agent 的 coin-60 EOA 直接呼叫，lane = \"eoa\"，畫面標「agent EOA」）；setMandate 的 agent 參數改填 agent signer。",
    });
  }
  const two = items.find((i) => i.id === 2);
  if (two?.verdict === "holds" && /需要 .*(PQC 註冊|window)/.test(two.summary)) {
    out.push({
      decisions: ["D-10", "D-12", "D-19", "D-27"],
      finding: `coin-60 signer 送 EVM 交易前需要前置條件：${two.summary}`,
      proposal:
        "owner 與 agent 的 coin-60 signer 先以 eth_secp256k1 註冊 ML-DSA-87（deriveUnifiedAccount 的 pqc 金鑰）；送 setMandate／confirmTicket／cancel 前各自開 window；/api/live/status 加查兩個 signer 的 PQC 與 window。",
    });
  }
  if (v(3) === "fails") {
    out.push({
      decisions: ["D-13"],
      finding: "allowedEvmCalls 的 selector 形式沒有擋下未列出的函式。",
      proposal: "不能靠 selector 規則保護 setMandate／revokeMandate：改走 EOA lane，或改合約讓 setMandate 拒絕 owner 帳號 0x 當 msg.sender（屬 #7 範圍，需另議）。",
    });
  }
  if (v(4) === "fails") {
    out.push({
      decisions: ["D-12"],
      finding: "window 管不到 MsgExecuteEVM。",
      proposal: "仍照需求開 window，但 /mandate 規則表「Scoped window · allowedTargets／maxTxs」改寫成它實際管住的東西（owner 帳號自己的 EVM 交易），不宣稱它擋住 agent（spec user story 13）。",
    });
  }
  if (v(5) === "fails") {
    out.push({
      decisions: ["D-23"],
      finding: "explorer 不認 0x EVM 交易雜湊。",
      proposal: "一般 EVM 交易（setMandate、confirmTicket、cancel）的 explorer 連結改用所在 Cosmos 交易的雜湊。",
    });
  }
  if (v(6) === "fails") {
    out.push({
      decisions: ["D-32"],
      finding: "商家簽章沒有被鏈上公鑰驗過。",
      proposal: "先查 bootstrap 註冊的金鑰是否就是 derivePqcCanonical(merchantQor1, MERCHANT_MNEMONIC)，再查 escrow 編碼模組的 message 前綴；修好前 Live 不可用。",
    });
  }
  return out;
}

/** The comment body for #16, or undefined when nothing is overturned. */
export function renderIssueComment(run: ProbeRun): string | undefined {
  const impacts = decisionImpacts(run.items);
  if (impacts.length === 0) return undefined;
  const lines = [
    `## diana 探測結果推翻／修正的決策（live:probe ${run.date}）`,
    "",
    "探測結果和 spec 不符時以探測為準。完整記錄見 `docs/FLOW.md`「diana 測試網實測記錄」。",
    "",
  ];
  for (const i of impacts) {
    lines.push(`- **${i.decisions.join("、")}**：${i.finding}`, `  - 建議：${i.proposal}`);
  }
  lines.push("", "後續 ticket 與 /revise-decision 依此更新。");
  return lines.join("\n");
}
