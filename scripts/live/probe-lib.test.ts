import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  allowedEvmCall,
  assertNoSecrets,
  decisionImpacts,
  feeUqor,
  judgeExecuteSender,
  judgeExplorer,
  judgePqcVerify,
  judgeSelectorRule,
  judgeSenderPrerequisites,
  judgeWindowGovernsExecute,
  readProbeEnv,
  RECORD_END,
  RECORD_START,
  renderIssueComment,
  renderRecord,
  replaceRecord,
  uqorToWei,
  weiToUqorCeil,
  type ItemResult,
  type ProbeRun,
} from "./probe-lib";

// Public Foundry/Hardhat test mnemonic: not a secret, safe in a test.
const M = "test test test test test test test test test test test junk";
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";

test("env: process env wins over the file, defaults fill the network", () => {
  const env = readProbeEnv(
    { OWNER_MNEMONIC: M, QORE_EXPLORER_URL: "https://explore.example/" },
    `AGENT_MNEMONIC="${M}"\nMERCHANT_MNEMONIC='${M}'\nOWNER_MNEMONIC=ignored\n# c\n`,
  );
  assert.equal(env.mnemonics.owner, M);
  assert.equal(env.mnemonics.agent, M);
  assert.equal(env.mnemonics.merchant, M);
  assert.equal(env.network.chainId, "qorechain-diana");
  assert.equal(env.network.explorer, "https://explore.example");
});

test("env: a missing mnemonic names the variable and never generates one", () => {
  assert.throws(
    () => readProbeEnv({ OWNER_MNEMONIC: M }, ""),
    (err: Error) => /AGENT_MNEMONIC, MERCHANT_MNEMONIC/.test(err.message) && !err.message.includes(M),
  );
});

test("assertNoSecrets refuses a mnemonic, a 12-word run of one, or a private key", () => {
  const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const long = `${M} extra words here`;
  assert.throws(() => assertNoSecrets(`oops ${M}`, [M]), /key material/);
  assert.throws(() => assertNoSecrets(`x ${M.toUpperCase()} y`, [long]), /key material/);
  assert.throws(() => assertNoSecrets(`k=${pk.slice(2)}`, [pk]), /key material/);
  assert.doesNotThrow(() => assertNoSecrets(`address ${OWNER} hash 0xabc`, [M, pk]));
});

test("amounts: uqor <-> wei, fee rounds up", () => {
  assert.equal(uqorToWei(BigInt(1_000)), BigInt("1000000000000000"));
  assert.equal(weiToUqorCeil(BigInt(1)), BigInt(1));
  assert.equal(weiToUqorCeil(uqorToWei(BigInt(7))), BigInt(7));
  assert.equal(feeUqor(1_000_000, "0.15"), BigInt(150_000));
  assert.equal(feeUqor(3, "0.15"), BigInt(1)); // 0.45 -> 1
});

test("allowedEvmCalls entry is 0x<target>/0x<selector>, lowercase", () => {
  assert.equal(
    allowedEvmCall("0xAbCdEf0000000000000000000000000000000001", "0x19E1FCA4"),
    "0xabcdef0000000000000000000000000000000001/0x19e1fca4",
  );
  assert.throws(() => allowedEvmCall("0x12", "0x19e1fca4"), /20-byte/);
  assert.throws(() => allowedEvmCall(OWNER, "0x19e1"), /4-byte/);
});

test("item 1: holds only when sender, value and the owner's balance all agree", () => {
  const base = { executed: true, ownerAccountEvm: OWNER, agentSigner: AGENT, sentValueWei: BigInt(1000) };
  assert.equal(
    judgeExecuteSender({ ...base, recordedSender: OWNER.toUpperCase().replace("0X", "0x"), recordedValueWei: BigInt(1000), ownerDropWei: BigInt(1000) }).verdict,
    "holds",
  );
  const agent = judgeExecuteSender({ ...base, recordedSender: AGENT, recordedValueWei: BigInt(1000), ownerDropWei: BigInt(0) });
  assert.equal(agent.verdict, "fails");
  assert.match(agent.summary, /agent 的 coin-60/);
  assert.equal(judgeExecuteSender({ ...base, recordedSender: OWNER, recordedValueWei: BigInt(1000), ownerDropWei: BigInt(0) }).verdict, "fails");
  assert.equal(judgeExecuteSender({ ...base, executed: false }).verdict, "inconclusive");
});

test("item 2: names the prerequisites each signer needed", () => {
  const j = judgeSenderPrerequisites([
    {
      role: "owner",
      steps: [
        { kind: "refused", rejection: "no-pqc-key", error: "x" },
        { kind: "registered-pqc", hash: "A" },
        { kind: "refused", rejection: "no-window", error: "y" },
        { kind: "opened-window", hash: "B" },
        { kind: "sent", hash: "0x1" },
      ],
    },
    { role: "agent", steps: [{ kind: "sent", hash: "0x2" }] },
  ]);
  assert.equal(j.verdict, "holds");
  assert.match(j.summary, /owner：需要 PQC 註冊 \+ window（依序被拒：no-pqc-key → no-window）/);
  assert.match(j.summary, /agent：不需前置條件/);
  const stuck = judgeSenderPrerequisites([{ role: "owner", steps: [{ kind: "error", error: "timeout" }] }]);
  assert.equal(stuck.verdict, "inconclusive");
});

test("item 3: blocked() must be refused and the call count must not move", () => {
  const ok = { kind: "success", hash: "H" } as const;
  assert.equal(
    judgeSelectorRule({ allowed: ok, blocked: { kind: "refused", code: 10, codespace: "abstractaccount", error: "permission" }, callsBefore: BigInt(2), callsAfter: BigInt(2) }).verdict,
    "holds",
  );
  assert.equal(
    judgeSelectorRule({ allowed: ok, blocked: { kind: "execution-failed", hash: "H2", reason: "not allowed" }, callsBefore: BigInt(2), callsAfter: BigInt(2) }).verdict,
    "holds",
  );
  assert.equal(judgeSelectorRule({ allowed: ok, blocked: ok }).verdict, "fails");
  assert.equal(judgeSelectorRule({ allowed: { kind: "error", error: "e" }, blocked: ok }).verdict, "inconclusive");
  assert.equal(judgeSelectorRule({ allowed: ok, blocked: { kind: "error", error: "timeout" } }).verdict, "inconclusive");
});

test("item 4: governs when refused without a window; not when a decoy-scoped window lets it through", () => {
  const ok = { kind: "success", hash: "H" } as const;
  assert.equal(
    judgeWindowGovernsExecute({ withoutWindow: { kind: "refused", error: "no open EVM authorisation window" }, windowRejection: "no-window" }).verdict,
    "holds",
  );
  assert.equal(judgeWindowGovernsExecute({ withoutWindow: ok, outsideScope: ok }).verdict, "fails");
  assert.equal(
    judgeWindowGovernsExecute({ withoutWindow: ok, outsideScope: { kind: "refused", error: "does not admit this transaction" } }).verdict,
    "inconclusive",
  );
});

test("item 5: needs a person's answer", () => {
  assert.equal(judgeExplorer({ evmHash: "0xab", answer: "y" }).verdict, "holds");
  assert.equal(judgeExplorer({ evmHash: "0xab", answer: "n" }).verdict, "fails");
  assert.equal(judgeExplorer({ evmHash: "0xab" }).verdict, "inconclusive");
  assert.equal(judgeExplorer({}).verdict, "inconclusive");
});

test("item 6: holds only with a matching key, both verifies true and the tampered control false", () => {
  const good = { pubkeyMatches: true, local: true, precompile: true, precompileTampered: false };
  assert.equal(judgePqcVerify(good).verdict, "holds");
  assert.equal(judgePqcVerify({ ...good, precompileTampered: true }).verdict, "fails");
  assert.equal(judgePqcVerify({ ...good, pubkeyMatches: false }).verdict, "fails");
  assert.equal(judgePqcVerify({ ...good, error: "429" }).verdict, "inconclusive");
});

const item = (id: ItemResult["id"], verdict: ItemResult["verdict"], summary = "s"): ItemResult => ({
  id,
  verdict,
  summary,
  evidence: [`evidence ${id}`],
  txs: id === 1 ? [{ label: "exec", hash: "ABCDEF", lane: "cosmos" }] : id === 2 ? [{ label: "deploy", hash: "0x12", lane: "evm" }] : [],
});

const run = (items: ItemResult[]): ProbeRun => ({
  date: "2026-11-24",
  sdkVersion: "0.14.0",
  chainId: "qorechain-diana",
  explorer: "https://explore.qore.network",
  probeAddress: OWNER,
  items,
});

test("record: a table row per item plus explorer links for every tx", () => {
  const md = renderRecord(run([item(2, "holds", "a | b"), item(1, "fails")]));
  assert.match(md, /\| 1 \| .* \| 不成立 \| s \|/);
  assert.match(md, /\| 2 \| .* \| 成立 \| a \\\| b \|/);
  assert.ok(md.indexOf("| 1 |") < md.indexOf("| 2 |"));
  assert.match(md, /\[`ABCDEF`\]\(https:\/\/explore\.qore\.network\/tx\/ABCDEF\)/);
  assert.match(md, /（EVM 0x）：\[`0x12`\]\(https:\/\/explore\.qore\.network\/tx\/0x12\)/);
});

test("record: replaces only what is between the FLOW.md markers", () => {
  const doc = `before\n${RECORD_START}\nold\n${RECORD_END}\nafter\n`;
  assert.equal(replaceRecord(doc, "new"), `before\n${RECORD_START}\nnew\n${RECORD_END}\nafter\n`);
  assert.throws(() => replaceRecord("no markers", "x"), /no <!-- live:probe:start -->/);
});

test("docs/FLOW.md carries the record markers", () => {
  const flow = readFileSync(resolve(import.meta.dirname, "../../docs/FLOW.md"), "utf8");
  assert.doesNotThrow(() => replaceRecord(flow, "x"));
});

test("decisions: failures map to the decisions they overturn", () => {
  const impacts = decisionImpacts([
    item(1, "fails"),
    item(2, "holds", "owner：需要 PQC 註冊 + window"),
    item(3, "holds"),
    item(4, "fails"),
    item(5, "fails"),
    item(6, "holds"),
  ]);
  const ds = impacts.flatMap((i) => i.decisions);
  for (const d of ["D-09", "D-10", "D-12", "D-19", "D-23"]) assert.ok(ds.includes(d), d);
  assert.ok(!ds.includes("D-13"));
  assert.ok(!ds.includes("D-32"));
  assert.match(renderIssueComment(run([item(1, "fails")])) ?? "", /D-09、D-10、ADR-0002/);
});

test("decisions: nothing to post when every item holds without prerequisites", () => {
  const all = ([1, 2, 3, 4, 5, 6] as const).map((id) => item(id, "holds", "不需前置條件"));
  assert.equal(renderIssueComment(run(all)), undefined);
});
