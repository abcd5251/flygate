// `pnpm escrow:e2e` - run FlightEscrow's three outcomes on diana against the deployed
// contract in deployments/diana.json, and record every tx hash and its gas there.
//   1. book -> confirmTicket  (merchant is paid)
//   2. book -> cancel         (merchant-signed failure proof, owner refunded at once)
//   3. book -> refund         (ticketWindow 120 s; wait past the deadline, owner refunded)
// The owner signer sets the mandate; the agent signer books and relays the merchant's
// proofs. The merchant signs quotes and proofs with its registered ML-DSA-87 key
// (derivePqcCanonical) and sends nothing. Flows already in the record are skipped.
import { derivePqcCanonical, fromBase } from "@qorechain/sdk";
import { bytesToHex, keccak256, parseEventLogs, stringToBytes, type TransactionReceipt } from "viem";
import { evmBalance, loadEvmSetup, pqcKeyStatusOnEvm, WEI_PER_UQOR, type EvmSetup } from "../evm/chain";
import type { Hex } from "../evm/keys";
import {
  bookingId as bookingIdOf,
  Cabin,
  cancelMessage,
  cityCode,
  DIANA_CHAIN_ID,
  escrowAbi,
  quoteMessage,
  signMessage,
  ticketMessage,
  verifyMessage,
  type CancelProof,
  type Domain,
  type MerchantKeys,
  type Quote,
  type TicketProof,
} from "../../src/lib/escrow";
import { agentWindow, FARE_WEI, GAS_CAP, ownerMandateWindow } from "./budget";
import { explorerTx, readRecord, writeRecord, type DeploymentRecord, type FlowRecord, type TxRecord } from "./record";
import { openWindow } from "./signers";
import { makeClients, sendContractTx, walletFor, type Clients, type Wallet } from "./tx";

const DAY = 86_400;
const unixDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000 / DAY;
const ROUTE = { origin: "TPE", destination: "TYO" } as const;
const DEPART_DAY = unixDay("2026-12-20");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const qor = (wei: bigint) => `${fromBase((wei / WEI_PER_UQOR).toString())} QOR`;

interface Ctx {
  setup: EvmSetup;
  record: DeploymentRecord;
  clients: Clients;
  escrow: Hex;
  domain: Domain;
  merchantKeys: MerchantKeys;
  owner: Wallet;
  agent: Wallet;
}

function txRecord(ctx: Ctx, r: TransactionReceipt): TxRecord {
  return {
    hash: r.transactionHash,
    block: Number(r.blockNumber),
    gasUsed: Number(r.gasUsed),
    url: explorerTx(ctx.setup.network.explorer, r.transactionHash),
  };
}

function log(label: string, t: TxRecord) {
  console.log(`  ${label.padEnd(14)} ${t.hash}  block ${t.block}  ${t.gasUsed} gas`);
}

/** Sign with the merchant key and check locally, as pqcVerify will, before anything is sent. */
function merchantSign(ctx: Ctx, message: Uint8Array): Hex {
  const sig = signMessage(message, ctx.merchantKeys.secretKey);
  if (!verifyMessage(bytesToHex(ctx.merchantKeys.publicKey), sig, message)) throw new Error("merchant signature does not verify");
  return sig;
}

const quoteArg = (q: Quote) => ({ ...q, origin: cityCode(q.origin), destination: cityCode(q.destination) });

async function setMandate(ctx: Ctx): Promise<void> {
  const { setup } = ctx;
  const now = Math.floor(Date.now() / 1000);
  const merchant = setup.roles.merchant.account.evm;
  const agent = setup.roles.agent.signer.address;
  const terms = {
    merchant,
    maxFareWei: FARE_WEI,
    // Confirmed tickets use quota for good; refunds return it. Room for a few reruns.
    maxTickets: 10,
    expiresAt: BigInt(now + 7 * DAY),
    origin: cityCode(ROUTE.origin),
    destination: cityCode(ROUTE.destination),
    departFrom: unixDay("2026-12-18"),
    departTo: unixDay("2026-12-22"),
    cabin: Cabin.Economy,
    refundableOnly: true,
  };
  const mandateHash = keccak256(
    stringToBytes(JSON.stringify({ app: "flygate-e2e", ...terms, maxFareWei: terms.maxFareWei.toString(), expiresAt: terms.expiresAt.toString() })),
  );
  await openWindow(setup, ctx.record, "owner", ownerMandateWindow(ctx.escrow), "setMandate");
  const r = await sendContractTx(ctx.clients, ctx.owner, {
    label: "setMandate",
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: "setMandate",
    args: [agent, { ...terms, mandateHash }],
    gasCap: GAS_CAP.setMandate,
  });
  ctx.record.mandate = { owner: setup.roles.owner.signer.address, agent, merchant, tx: txRecord(ctx, r) };
  writeRecord(ctx.record);
  log("setMandate", ctx.record.mandate.tx);
}

async function book(ctx: Ctx, flow: string, ticketWindow: number): Promise<{ id: Hex; deadline: bigint; tx: TxRecord }> {
  const now = Math.floor(Date.now() / 1000);
  const quote: Quote = {
    merchant: ctx.setup.roles.merchant.account.evm,
    agent: ctx.setup.roles.agent.signer.address,
    owner: ctx.setup.roles.owner.signer.address,
    offerId: keccak256(stringToBytes(`flygate-e2e|${flow}|${now}`)),
    priceWei: FARE_WEI,
    ...ROUTE,
    departDay: DEPART_DAY,
    cabin: Cabin.Economy,
    refundable: true,
    expiresAt: BigInt(now + 600),
    ticketWindow,
  };
  const signature = merchantSign(ctx, quoteMessage(quote, ctx.domain));
  const r = await sendContractTx(ctx.clients, ctx.agent, {
    label: `${flow}: book`,
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: "book",
    args: [quoteArg(quote), signature],
    value: FARE_WEI,
    gasCap: GAS_CAP.book,
  });
  const [booked] = parseEventLogs({ abi: escrowAbi, eventName: "Booked", logs: r.logs });
  if (!booked || booked.args.bookingId !== bookingIdOf(quote)) throw new Error(`${flow}: no Booked event for the quote`);
  const tx = txRecord(ctx, r);
  log("book", tx);
  return { id: booked.args.bookingId, deadline: booked.args.deadline, tx };
}

function saveFlow(ctx: Ctx, flow: "confirm" | "cancel" | "refund", record: FlowRecord) {
  ctx.record.flows[flow] = record;
  writeRecord(ctx.record);
}

async function confirmFlow(ctx: Ctx): Promise<void> {
  console.log("\n1. book -> confirmTicket");
  const merchant = ctx.setup.roles.merchant.account.evm;
  const before = await evmBalance(ctx.setup.network.evmRpc, merchant);
  const b = await book(ctx, "confirm", 600);
  saveFlow(ctx, "confirm", { bookingId: b.id, book: b.tx });
  const proof: TicketProof = {
    bookingId: b.id,
    pnrHash: keccak256(stringToBytes(`PNR ZZ101A|salt ${bytesToHex(crypto.getRandomValues(new Uint8Array(16)))}`)),
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
  };
  const r = await sendContractTx(ctx.clients, ctx.agent, {
    label: "confirmTicket",
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: "confirmTicket",
    args: [proof, merchantSign(ctx, ticketMessage(proof, ctx.domain))],
    gasCap: GAS_CAP.confirmTicket,
  });
  const [released] = parseEventLogs({ abi: escrowAbi, eventName: "Released", logs: r.logs });
  if (!released || released.args.bookingId !== b.id) throw new Error("confirmTicket: no Released event");
  const tx = txRecord(ctx, r);
  saveFlow(ctx, "confirm", { bookingId: b.id, book: b.tx, confirmTicket: tx });
  log("confirmTicket", tx);
  const after = await evmBalance(ctx.setup.network.evmRpc, merchant);
  console.log(`  merchant ${merchant}: ${qor(before)} -> ${qor(after)}`);
}

async function cancelFlow(ctx: Ctx): Promise<void> {
  console.log("\n2. book -> cancel");
  const b = await book(ctx, "cancel", 600);
  saveFlow(ctx, "cancel", { bookingId: b.id, book: b.tx });
  const proof: CancelProof = { bookingId: b.id, reasonCode: 1 };
  const r = await sendContractTx(ctx.clients, ctx.agent, {
    label: "cancel",
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: "cancel",
    args: [proof, merchantSign(ctx, cancelMessage(proof, ctx.domain))],
    gasCap: GAS_CAP.cancel,
  });
  const [refunded] = parseEventLogs({ abi: escrowAbi, eventName: "Refunded", logs: r.logs });
  if (!refunded || refunded.args.reason !== 0) throw new Error("cancel: no Refunded(Cancelled) event");
  const tx = txRecord(ctx, r);
  saveFlow(ctx, "cancel", { bookingId: b.id, book: b.tx, cancel: tx });
  log("cancel", tx);
}

async function refundFlow(ctx: Ctx): Promise<void> {
  console.log("\n3. book -> refund (ticketWindow 120 s)");
  const b = await book(ctx, "refund", 120);
  saveFlow(ctx, "refund", { bookingId: b.id, book: b.tx });
  console.log(`  waiting for a block after the deadline ${new Date(Number(b.deadline) * 1000).toISOString()} ...`);
  for (;;) {
    const block = await ctx.clients.reads.getBlock({ blockTag: "latest" });
    if (block.timestamp > b.deadline) break;
    await sleep(Math.min(15_000, Math.max(2_000, Number(b.deadline - block.timestamp) * 1000)));
  }
  const r = await sendContractTx(ctx.clients, ctx.agent, {
    label: "refund",
    address: ctx.escrow,
    abi: escrowAbi,
    functionName: "refund",
    args: [b.id],
    gasCap: GAS_CAP.refund,
  });
  const [refunded] = parseEventLogs({ abi: escrowAbi, eventName: "Refunded", logs: r.logs });
  if (!refunded || refunded.args.reason !== 1) throw new Error("refund: no Refunded(Expired) event");
  const tx = txRecord(ctx, r);
  saveFlow(ctx, "refund", { bookingId: b.id, book: b.tx, refund: tx });
  log("refund", tx);
}

const gasOf = (t: TxRecord | Hex | undefined) => (typeof t === "object" ? (t.gasUsed ?? 0) : 0);

async function main(): Promise<void> {
  const setup = await loadEvmSetup();
  const record = readRecord(setup.network.explorer);
  if (!record.contract) throw new Error("No contract in deployments/diana.json. Run `pnpm escrow:deploy` first.");
  const escrow = record.contract.address;
  const clients = makeClients(setup.network);

  const merchant = setup.roles.merchant.account;
  const merchantKeys = derivePqcCanonical(merchant.cosmos, setup.mnemonics.merchant);
  const status = await pqcKeyStatusOnEvm(setup.network.evmRpc, merchant.evm);
  if (!status.registered || !status.possessionProven || !Buffer.from(status.pubkey).equals(Buffer.from(merchantKeys.publicKey))) {
    throw new Error(`pqcKeyStatus(${merchant.evm}) does not hold the merchant's derivePqcCanonical key. Run \`pnpm evm:check\`.`);
  }

  const ctx: Ctx = {
    setup,
    record,
    clients,
    escrow,
    domain: { chainId: DIANA_CHAIN_ID, escrow },
    merchantKeys,
    owner: walletFor(clients, setup.roles.owner.signer.privateKey),
    agent: walletFor(clients, setup.roles.agent.signer.privateKey),
  };
  const done = (f: FlowRecord | undefined, step: string) => f !== undefined && typeof f[step] === "object";
  const todo = {
    confirm: !done(record.flows.confirm, "confirmTicket"),
    cancel: !done(record.flows.cancel, "cancel"),
    refund: !done(record.flows.refund, "refund"),
  };
  console.log(`FlightEscrow ${escrow}`);
  if (!todo.confirm && !todo.cancel && !todo.refund) {
    console.log("All three flows are already recorded; nothing to send.");
  } else {
    const ownerSigner = setup.roles.owner.signer.address;
    const ownerBefore = await evmBalance(setup.network.evmRpc, ownerSigner);
    if (!record.mandate) await setMandate(ctx);
    await openWindow(setup, record, "agent", agentWindow(escrow), "3 bookings + confirmTicket/cancel/refund");
    if (todo.confirm) await confirmFlow(ctx);
    if (todo.cancel) await cancelFlow(ctx);
    if (todo.refund) await refundFlow(ctx);
    const ownerAfter = await evmBalance(setup.network.evmRpc, ownerSigner);
    console.log(`\nowner signer ${ownerSigner}: ${qor(ownerBefore)} -> ${qor(ownerAfter)} (refunds)`);
  }

  const f = record.flows;
  record.gas = {
    book: gasOf(f.confirm?.book),
    confirmTicket: gasOf(f.confirm?.confirmTicket),
    cancel: gasOf(f.cancel?.cancel),
    refund: gasOf(f.refund?.refund),
  };
  writeRecord(record);
  console.log(`\nGas used: ${JSON.stringify(record.gas)}`);
}

main().catch((err: unknown) => {
  console.error(`\nescrow:e2e failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
