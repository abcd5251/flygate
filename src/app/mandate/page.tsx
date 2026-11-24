"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { BoardingPass } from "@/components/BoardingPass";
import { FlowBand } from "@/components/FlowBand";
import { Card, HashText, PrimaryButton, SourceTag } from "@/components/ui";
import { WalletModal } from "@/components/WalletModal";
import { ADDRESSES, getChain, MANDATE_TX_STEPS, shortAddr } from "@/lib/chain";
import { formatExpiry, mandateRules, usd } from "@/lib/mandate";
import { encryptPassenger, preview, signAsOwner, type SignResult } from "@/lib/pq";
import { useDemo } from "@/lib/store";
import type { PassengerInput } from "@/lib/types";

export default function MandatePage() {
  const router = useRouter();
  const { state, update, addTx, wait } = useDemo();
  const m = state.draft;
  const [walletOpen, setWalletOpen] = useState(false);
  const signRef = useRef<SignResult | null>(null);
  const encRef = useRef<Awaited<ReturnType<typeof encryptPassenger>> | null>(null);
  const signed = state.signed;
  const rules = mandateRules(m);
  const p = state.passengerInput;

  function setPassenger(patch: Partial<PassengerInput>) {
    update((s) => ({ ...s, passengerInput: { ...s.passengerInput, ...patch } }));
  }

  const steps = [
    { label: "Hash the mandate and sign it with ML-DSA-87" },
    { label: "Encrypt the passport for the merchant (ML-KEM-1024)" },
    { label: "Link the agent key (auto-expires)" },
    { label: `Set spending cap: ${m.maxFareUsd} fUSD per ticket` },
    { label: `Open scoped window: FlightEscrow only, ${m.maxTickets} tx` },
  ];

  async function runStep(i: number) {
    if (i === 0) {
      const r = await signAsOwner({ mandate: m, owner: ADDRESSES.owner, agent: ADDRESSES.agent });
      signRef.current = r;
      return `${r.sigBytes.toLocaleString()} bytes · ${r.ms} ms · ${r.verified ? "verified" : "failed"}`;
    }
    if (i === 1) {
      const e = await encryptPassenger(p);
      encRef.current = e;
      return `KEM ${e.kemCiphertextBytes.toLocaleString()} bytes + AES-GCM ${e.aesCiphertextBytes} bytes`;
    }
    await wait(650);
    const tx = await getChain().setupMandate({ step: MANDATE_TX_STEPS[i - 2], mandate: m, mandateHash: signRef.current?.hash });
    addTx(tx);
    return `${tx.msg} · ${tx.hash.slice(0, 14)}…`;
  }

  function onSigned() {
    const r = signRef.current;
    const e = encRef.current;
    if (!r || !e) return;
    update((s) => ({
      ...s,
      signed: {
        hash: r.hash,
        sigBytes: r.sigBytes,
        pkBytes: r.pkBytes,
        sigPreview: preview(r.sig),
        signMs: r.ms,
        signedAt: Date.now(),
        agentAddress: ADDRESSES.agent,
      },
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
                  <Row k="Agent key">
                    <span className="font-mono text-xs">{shortAddr(signed.agentAddress, 9, 4)}</span>
                  </Row>
                </dl>
                <ul className="space-y-2 border-t border-line pt-4">
                  {ownerTxs.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-ink">{t.label}</span>
                      <HashText value={t.hash} head={8} tail={4} explorerUrl={t.explorerUrl} />
                    </li>
                  ))}
                </ul>
                <PrimaryButton className="w-full" onClick={() => router.push("/search")}>
                  Let the agent book <ArrowRight className="size-5" />
                </PrimaryButton>
              </div>
            ) : (
              <div className="space-y-4">
                <h2 className="text-lg font-bold text-ink">One signature sets 3 things</h2>
                <ol className="space-y-3 text-sm">
                  {[`Agent key, valid until ${formatExpiry(m.expiresAt)}`, `Spending cap: ${usd(m.maxFareUsd)} per ticket`, "Payments go to escrow only"].map((t, i) => (
                    <li key={t} className="flex gap-3">
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-50 text-xs font-bold text-brand">{i + 1}</span>
                      {t}
                    </li>
                  ))}
                </ol>
                <p className="flex items-start gap-2 rounded-xl bg-pq-50 p-3 text-xs text-pq">
                  <ShieldCheck className="size-4 shrink-0" /> Only your ML-DSA-87 key can change these rules.
                </p>
                <PrimaryButton className="w-full py-4" onClick={() => setWalletOpen(true)}>
                  Sign with QoreX
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
            { k: "Agent", v: shortAddr(ADDRESSES.agent, 9, 4) },
          ]}
          steps={steps}
          runStep={runStep}
          onDone={onSigned}
          onClose={() => setWalletOpen(false)}
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
