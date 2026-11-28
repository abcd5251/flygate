"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { BoardingPass } from "@/components/BoardingPass";
import { FlowBand } from "@/components/FlowBand";
import { Card, HashText, PrimaryButton, SourceTag } from "@/components/ui";
import { WalletModal } from "@/components/WalletModal";
import { keccak256, type Hex } from "viem";
import { ADDRESSES, CHAIN, liveChain, liveOwner, shortAddr, simulatedChain, SIMULATED_MANDATE_STEPS, type ChainStatus, type MandatePlan } from "@/lib/chain";
import { formatExpiry, mandateRules, usd } from "@/lib/mandate";
import { encryptPassenger, preview, signAsOwner, type SignResult } from "@/lib/pq";
import { connectQorex, isRejection, newSessionKey, signAndBroadcast } from "@/lib/qorex";
import { useDemo } from "@/lib/store";
import type { LiveAddresses, PassengerInput } from "@/lib/types";

/** ML-DSA-87 signature size: the post-quantum half of every QoreX transaction signature. */
const ML_DSA_87_SIG_BYTES = 4627;

export default function MandatePage() {
  const router = useRouter();
  const { state, update, addTx, wait, latest } = useDemo();
  const m = state.draft;
  const [walletOpen, setWalletOpen] = useState(false);
  const signRef = useRef<SignResult | null>(null);
  const encRef = useRef<Awaited<ReturnType<typeof encryptPassenger>> | null>(null);
  /** Live: this signing's session key, the wallet plan, and what the wallet sent. */
  const liveRef = useRef<{ owner: string; sessionKey: string; plan?: Extract<MandatePlan, { ok: true }>; txHash?: string; shield?: string } | null>(null);
  // A mandate signed in the other mode has to be signed again in this one (D-25).
  const signed = state.signed && (state.signed.mode ?? "simulated") === state.mode ? state.signed : undefined;
  const rules = mandateRules(m);
  const p = state.passengerInput;
  const mode = state.mode;
  const [live, setLive] = useState<ChainStatus | undefined>();
  const liveAddrs: LiveAddresses | undefined = mode === "live" ? live?.addresses : undefined;

  // Live: the addresses the server signs with (public data only), for the wallet and the mandate.
  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    liveChain.status().then((st) => {
      if (!cancelled) setLive(st);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  /** Simulated: the demo constants. */
  function parties() {
    return { owner: ADDRESSES.owner, agent: ADDRESSES.agent };
  }

  function setPassenger(patch: Partial<PassengerInput>) {
    update((s) => ({ ...s, passengerInput: { ...s.passengerInput, ...patch } }));
  }

  const steps =
    mode === "live"
      ? [
          { label: "Encrypt the passport for the merchant (ML-KEM-1024)" },
          { label: `Prepare: deposit up to ${usd(m.maxFareUsd * m.maxTickets)} of QOR + the mandate for FlyGate's agent` },
          { label: "Approve in QoreX (secp256k1 + ML-DSA-87)" },
          { label: "FlightEscrow holds your deposit and rules" },
        ]
      : [
          { label: "Hash the mandate and sign it with ML-DSA-87" },
          { label: "Encrypt the passport for the merchant (ML-KEM-1024)" },
          { label: "Link the agent key (auto-expires)" },
          { label: `Set spending cap: ${m.maxFareUsd} fUSD per ticket` },
          { label: `Open scoped window: FlightEscrow only, ${m.maxTickets} tx` },
        ];

  async function runStep(i: number) {
    return latest().mode === "live" ? runLiveStep(i) : runSimulatedStep(i);
  }

  async function encrypt() {
    const e = await encryptPassenger(p);
    encRef.current = e;
    return `KEM ${e.kemCiphertextBytes.toLocaleString()} bytes + AES-GCM ${e.aesCiphertextBytes} bytes`;
  }

  async function runSimulatedStep(i: number) {
    if (i === 0) {
      const r = await signAsOwner({ mandate: m, ...parties(), nonce: crypto.randomUUID() });
      signRef.current = r;
      return `${r.sigBytes.toLocaleString()} bytes · ${r.ms} ms · ${r.verified ? "verified" : "failed"}`;
    }
    if (i === 1) return encrypt();
    const [tx] = await Promise.all([simulatedChain.setupMandate({ step: SIMULATED_MANDATE_STEPS[i - 2], mandate: m, mandateHash: signRef.current?.hash }), wait(650)]);
    addTx(tx);
    return `${tx.msg} · ${tx.hash.slice(0, 14)}…`;
  }

  /**
   * Live: the owner's own QoreX wallet signs one transaction (deposit + openMandate); FlyGate's
   * server only builds it and then checks on diana that FlightEscrow holds it (ADR-0003).
   */
  async function runLiveStep(i: number) {
    if (i === 0) {
      // A fresh session key per signing: its hash goes into the on-chain mandateHash.
      const owner = latest().wallet ?? (await connectWallet());
      liveRef.current = { owner, sessionKey: newSessionKey() };
      return encrypt();
    }
    const l = liveRef.current!;
    const controlHash = keccak256(l.sessionKey as Hex);
    if (i === 1) {
      const plan = await liveOwner.prepareMandate({ mandate: m, owner: l.owner, controlHash });
      if (!plan.ok) throw new Error(`${plan.code} · ${plan.reason}`);
      l.plan = plan;
      return plan.depositQor === "0"
        ? `Your budget already covers it (${plan.budgetQor} QOR) · agent ${shortAddr(plan.agent, 6, 4)}`
        : `Deposit ${plan.depositQor} QOR → FlightEscrow · budget ${plan.budgetQor} QOR · agent ${shortAddr(plan.agent, 6, 4)}`;
    }
    if (i === 2) {
      try {
        const r = await signAndBroadcast(l.plan!.request);
        l.txHash = r.txHash;
        l.shield = r.shield;
        return `tx ${r.txHash.slice(0, 12)}… · ${r.shield}`;
      } catch (err) {
        if (isRejection(err)) throw new Error("You declined in QoreX. Nothing was sent.");
        throw err;
      }
    }
    const tx = await liveOwner.confirmMandate({ mandate: m, owner: l.owner, controlHash, txHash: l.txHash! });
    if (!tx.ok) throw new Error(`${tx.code ?? "failed"}${tx.reason ? ` · ${tx.reason}` : ""}`);
    addTx(tx);
    return `${tx.msg} · ${tx.hash.slice(0, 14)}…`;
  }

  async function connectWallet() {
    const owner = await connectQorex(CHAIN.chainId);
    update((s) => ({ ...s, wallet: owner }));
    return owner;
  }

  function onSigned() {
    const e = encRef.current;
    const l = liveRef.current;
    const r = signRef.current;
    if (!e) return;
    const isLive = latest().mode === "live";
    if (isLive ? !l?.plan : !r) return;
    const signed =
      isLive && l?.plan
        ? {
            hash: l.plan.mandateHash,
            sigBytes: ML_DSA_87_SIG_BYTES,
            pkBytes: 2592,
            sigPreview: l.txHash ?? "",
            signMs: 0,
            signedAt: Date.now(),
            agentAddress: l.plan.agent,
            mode: "live" as const,
            live: { owner: l.owner, sessionKey: l.sessionKey, depositQor: l.plan.depositQor, budgetQor: l.plan.budgetQor, shield: l.shield },
          }
        : {
            hash: r!.hash,
            sigBytes: r!.sigBytes,
            pkBytes: r!.pkBytes,
            sigPreview: preview(r!.sig),
            signMs: r!.ms,
            signedAt: Date.now(),
            agentAddress: parties().agent,
            mode: "simulated" as const,
          };
    update((s) => ({
      ...s,
      signed,
      passenger: {
        displayName: `${s.passengerInput.surname} / ${s.passengerInput.givenName}`,
        passportMasked: `${s.passengerInput.passportNo.slice(0, 2)}•••••${s.passengerInput.passportNo.slice(-2)}`,
        kemCiphertextBytes: e.kemCiphertextBytes,
        aesCiphertextBytes: e.aesCiphertextBytes,
        preview: e.preview,
      },
    }));
    setWalletOpen(false);
  }

  const ownerTxs = state.txs.filter((t) => t.kind === "owner").slice(0, 3).reverse();

  return (
    <>
      <FlowBand
        current={1}
        title={signed ? "Mandate signed" : "Sign your mandate"}
        subtitle={signed ? "The agent can now book, but only inside these rules." : "Sign once. The agent can only act inside these rules."}
      />

      <div className="mx-auto -mt-14 grid max-w-[1440px] gap-6 px-4 pb-24 lg:grid-cols-[1fr_400px] lg:px-8">
        <div className="min-w-0 space-y-6">
          <BoardingPass m={m} hash={signed?.hash} signedLabel={signed ? "Signed · ML-DSA-87" : undefined} />

          <Card className="overflow-hidden">
            <div className="border-b border-line px-6 py-4">
              <h2 className="text-lg font-bold text-ink">{rules.length} rules, enforced on-chain</h2>
              <p className="text-sm text-muted">The AI can&apos;t change them. A stolen agent key can&apos;t either.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="bg-canvas text-xs text-muted">
                    <th className="px-6 py-2.5 font-bold">You said</th>
                    <th className="px-6 py-2.5 font-bold">Enforced by</th>
                    <th className="px-6 py-2.5 font-bold">Blocks</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.key} className="border-t border-line">
                      <td className="px-6 py-3 font-bold text-ink">{r.says}</td>
                      <td className="px-6 py-3 font-mono text-xs text-ink-2">{r.mechanism}</td>
                      <td className="px-6 py-3 text-ink-2">{r.blocks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-ink">Traveler</h2>
              <span className="inline-flex items-center gap-1.5 text-xs text-pq">
                <Lock className="size-3.5" /> Encrypted in your browser. The agent never sees it.
              </span>
            </div>
            {signed && state.passenger ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <Info k="Name" v={state.passenger.displayName} />
                <Info k="Passport" v={state.passenger.passportMasked} />
                <div>
                  <p className="text-xs text-muted">Sent to merchant as</p>
                  <p className="font-mono text-xs break-all text-ink-2">0x{state.passenger.preview}…</p>
                  <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                    ML-KEM-1024 ciphertext <SourceTag kind="crypto" />
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-4">
                <Input label="Surname" value={p.surname} onChange={(v) => setPassenger({ surname: v.toUpperCase() })} />
                <Input label="Given name" value={p.givenName} onChange={(v) => setPassenger({ givenName: v.toUpperCase() })} />
                <Input label="Passport no. (sample)" value={p.passportNo} onChange={(v) => setPassenger({ passportNo: v })} />
                <Input label="Nationality" value={p.nationality} onChange={(v) => setPassenger({ nationality: v.toUpperCase() })} />
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-32 lg:self-start">
          <Card className="p-6">
            {signed ? (
              <div className="space-y-4">
                <p className="inline-flex items-center gap-2 text-lg font-bold text-pass">
                  <CheckCircle2 className="size-6" /> Mandate is on-chain
                </p>
                <dl className="space-y-2 text-sm">
                  <Row k="Mandate hash">
                    <HashText value={signed.hash} />
                  </Row>
                  <Row k="ML-DSA-87 signature">
                    <span className="font-mono text-xs">{signed.sigBytes.toLocaleString()} bytes</span>
                  </Row>
                  <Row k={signed.live ? "FlyGate agent" : "Agent key"}>
                    <span className="font-mono text-xs">{shortAddr(signed.agentAddress, 9, 4)}</span>
                  </Row>
                  {signed.live && (
                    <>
                      <Row k="Your account">
                        <span className="font-mono text-xs">{shortAddr(signed.live.owner, 9, 4)}</span>
                      </Row>
                      <Row k="Budget in escrow">
                        <span className="font-mono text-xs">{signed.live.budgetQor} QOR</span>
                      </Row>
                    </>
                  )}
                </dl>
                <ul className="space-y-2 border-t border-line pt-4">
                  {ownerTxs.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink">{t.label}</span>
                      <span className="flex items-center gap-2">
                        {t.source === "live" && t.ok && <SourceTag kind="live-tx" />}
                        <HashText value={t.hash} head={8} tail={4} explorerUrl={t.explorerUrl} />
                      </span>
                    </li>
                  ))}
                </ul>
                <PrimaryButton className="w-full" onClick={() => router.push("/search")}>
                  Let the agent book <ArrowRight className="size-5" />
                </PrimaryButton>
                {signed.live && <CloseMandate owner={signed.live.owner} />}
              </div>
            ) : (
              <div className="space-y-4">
                <h2 className="text-lg font-bold text-ink">One signature sets 3 things</h2>
                <ol className="space-y-3 text-sm">
                  {(mode === "live"
                    ? [`Deposit up to ${usd(m.maxFareUsd * m.maxTickets)} of QOR into FlightEscrow`, `The agent may spend it only on ${usd(m.maxFareUsd)} tickets that match, until ${formatExpiry(m.expiresAt)}`, "Withdraw what is unspent any time"]
                    : [`Agent key, valid until ${formatExpiry(m.expiresAt)}`, `Spending cap: ${usd(m.maxFareUsd)} per ticket`, "Payments go to escrow only"]
                  ).map((t, i) => (
                    <li key={t} className="flex gap-3">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand">{i + 1}</span>
                      {t}
                    </li>
                  ))}
                </ol>
                <p className="flex items-start gap-2 rounded-xl bg-pq-50 p-3 text-xs text-pq">
                  <ShieldCheck className="size-4 shrink-0" />
                  {mode === "live" ? "You sign in your own QoreX wallet. FlyGate never sees your keys or recovery phrase." : "Only your ML-DSA-87 key can change these rules."}
                </p>
                <PrimaryButton className="w-full py-4" onClick={() => setWalletOpen(true)}>
                  {mode === "live" && !state.wallet ? "Connect QoreX and sign" : "Sign with QoreX"}
                </PrimaryButton>
                <Link href="/" className="block text-center text-sm text-brand hover:underline">
                  Edit trip
                </Link>
              </div>
            )}
          </Card>
        </aside>
      </div>

      {walletOpen && (
        <WalletModal
          open
          title="Sign flight mandate"
          summary={[
            { k: "Route", v: `${m.origin.city} → ${m.destination.city}` },
            { k: "Max fare", v: usd(m.maxFareUsd) },
            { k: "Expires", v: formatExpiry(m.expiresAt) },
            { k: "Agent", v: shortAddr(liveAddrs?.agent.signer ?? ADDRESSES.agent, 9, 4) },
            ...(mode === "live" ? [{ k: "Deposit", v: `up to ${usd(m.maxFareUsd * m.maxTickets)} in QOR` }] : []),
          ]}
          signer={mode === "live" ? "wallet" : "simulated"}
          accounts={
            mode === "live"
              ? [
                  { k: "Pays from", v: state.wallet ? shortAddr(state.wallet, 10, 6) : "the QoreX account you connect" },
                  { k: "Refunds to", v: "your budget in FlightEscrow (withdraw any time)" },
                ]
              : undefined
          }
          steps={steps}
          runStep={runStep}
          onDone={onSigned}
          onClose={() => setWalletOpen(false)}
          fallbackLabel={mode === "live" ? "Sign in Simulated mode instead" : undefined}
          onFallback={() => update((s) => ({ ...s, mode: "simulated" }))}
        />
      )}
    </>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{k}</p>
      <p className="font-bold text-ink">{v}</p>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block min-w-0 rounded-xl border border-line px-4 py-2 focus-within:border-brand">
      <span className="block text-xs text-muted">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full bg-transparent font-bold text-ink outline-none" />
    </label>
  );
}

/**
 * Live: revoke FlyGate's agent and get the unspent budget back, signed in the owner's QoreX
 * wallet (closeMandate). Bookings already locked still settle; their refunds come straight back.
 */
function CloseMandate({ owner }: { owner: string }) {
  const { update, addTx } = useDemo();
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState<string | undefined>();

  async function close() {
    setPhase("busy");
    setMessage(undefined);
    try {
      const plan = await liveOwner.prepareClose(owner);
      if (!plan.ok) throw new Error(plan.reason);
      const { txHash } = await signAndBroadcast(plan.request);
      const tx = await liveOwner.confirmClose(owner, txHash);
      if (!tx.ok) throw new Error(`${tx.code ?? "failed"}${tx.reason ? ` · ${tx.reason}` : ""}`);
      addTx(tx);
      update((s) => ({ ...s, signed: undefined, revoked: true }));
      setMessage(`${plan.refundQor} QOR returned to your wallet.`);
      setPhase("done");
    } catch (err) {
      setMessage(isRejection(err) ? "You declined in QoreX. Nothing was sent." : err instanceof Error ? err.message : String(err));
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-2 border-t border-line pt-4 text-xs">
      <button type="button" onClick={close} disabled={phase !== "idle"} className="font-bold text-block hover:underline disabled:opacity-50">
        {phase === "busy" ? "Waiting for QoreX…" : "Close mandate and withdraw the budget"}
      </button>
      {message && <p className="text-ink-2">{message}</p>}
    </div>
  );
}
