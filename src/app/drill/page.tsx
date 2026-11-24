"use client";

import { useEffect, useRef, useState } from "react";
import { Atom, KeyRound, Play, ShieldCheck, ShieldOff, Skull } from "lucide-react";
import { EmptyState } from "@/components/FlowBand";
import { cx, Spinner } from "@/components/ui";
import { WalletModal } from "@/components/WalletModal";
import { ADDRESSES, ERROR_CODES, makeTx, shortAddr, STARTING_BALANCE_USD } from "@/lib/chain";
import { formatExpiry, usd } from "@/lib/mandate";
import { forgeOwnerSignature, signAsOwner } from "@/lib/pq";
import { useDemo } from "@/lib/store";
import type { AttackKey } from "@/lib/types";

type Attack = {
  key: AttackKey;
  title: string;
  cmd: string;
  rule: string;
  error: { code: string; name: string };
  quantum?: boolean;
};

export default function DrillPage() {
  const { state, ready, update, wait, latest, addTx } = useDemo();
  const [running, setRunning] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [qdayResult, setQdayResult] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const m = state.draft;

  const attacks: Attack[] = [
    {
      key: "overspend",
      title: "Overspend",
      cmd: `agent.pay(FlightEscrow, 900 fUSD)   # sneak in business class`,
      rule: `Spending rule perTxLimit = ${m.maxFareUsd} fUSD`,
      error: ERROR_CODES.spending,
    },
    {
      key: "drain",
      title: "Drain funds",
      cmd: `agent.transfer(${shortAddr(ADDRESSES.attacker, 8, 4)}, ${m.maxFareUsd} fUSD)`,
      rule: "The agent can only pay FlightEscrow",
      error: ERROR_CODES.permission,
    },
    {
      key: "replay",
      title: "Replay",
      cmd: "relay(last FlightEscrow.book signature)",
      rule: "Each agent key has its own nonce; used once, dead",
      error: ERROR_CODES.replay,
    },
    {
      key: "expired",
      title: "After expiry",
      cmd: `clock.set("Dec 20 00:00"); agent.pay(FlightEscrow, 300 fUSD)`,
      rule: `The agent key expired ${formatExpiry(m.expiresAt)}`,
      error: ERROR_CODES.expired,
    },
    {
      key: "qday",
      title: "Q-Day: raise the cap as you",
      cmd: "quantum.break(owner.ecdsa); owner.updateSpendingRules(perTxLimit = 10,000)",
      rule: "Rule changes need your ML-DSA-87 signature. Quantum can't forge it.",
      error: ERROR_CODES.hybrid,
      quantum: true,
    },
  ];
  const afterRevoke: Attack = {
    key: "revoked",
    title: "After revoke",
    cmd: "agent.pay(FlightEscrow, 50 fUSD)   # revoked key",
    rule: "The agent key is no longer linked",
    error: ERROR_CODES.notLinked,
  };
  const visible = state.revoked ? [...attacks, afterRevoke] : attacks;
  const done = visible.filter((a) => state.attacks[a.key] === "blocked").length;
  const balance = STARTING_BALANCE_USD - state.spentUsd;

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight, behavior: "smooth" });
  }, [state.attacks, qdayResult]);

  async function runOne(a: Attack) {
    update((s) => ({ ...s, attacks: { ...s.attacks, [a.key]: "running" } }));
    await wait(1100);
    if (a.quantum) {
      const r = await forgeOwnerSignature({ action: "updateSpendingRules", perTxLimit: 10000, owner: ADDRESSES.owner });
      setQdayResult(`pqcVerify(your ML-DSA-87 key, forged signature) → ${r.acceptedByChain}`);
    }
    addTx(makeTx(`Attack: ${a.title}`, a.cmd, "attacker", false, a.error.code));
    update((s) => ({ ...s, attacks: { ...s.attacks, [a.key]: "blocked" } }));
  }

  async function runAll() {
    setRunning(true);
    for (const a of visible) {
      if (latest().attacks[a.key] === "blocked") continue;
      await runOne(a);
      await wait(400);
    }
    setRunning(false);
  }

  if (!ready) return null;
  if (!state.signed) {
    return (
      <div className="pt-20">
        <EmptyState title="Sign a mandate first" body="The drill needs a linked agent key." href="/" cta="Set up a trip" />
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-night text-white">
      <div className="mx-auto max-w-[1440px] space-y-6 px-4 py-10 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2 text-sm font-bold text-[#ff8a7a]">
              <Skull className="size-4" /> Breach drill
            </p>
            <h1 className="mt-2 text-3xl font-black md:text-4xl">The agent&apos;s key just got stolen.</h1>
            <p className="mt-2 text-white/70">The attacker has the key, and a quantum computer that breaks ECDSA. How much can they take?</p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <Score label="Attacks" value={String(done)} />
            <Score label="Succeeded" value="0" tone="ok" />
            <Score label="Lost" value={usd(0)} tone="ok" />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* Attacker console */}
          <div className="overflow-hidden rounded-2xl border border-night-line bg-night-2">
            <div className="flex items-center justify-between border-b border-night-line px-5 py-3">
              <span className="font-mono text-sm text-white/60">attacker@leaked-key:~$</span>
              <button
                type="button"
                onClick={runAll}
                disabled={running || done === visible.length}
                className="inline-flex items-center gap-2 rounded-lg bg-[#ff5c4d] px-4 py-2 text-sm font-bold text-white hover:bg-[#ff7366] disabled:bg-white/10 disabled:text-white/40"
              >
                {running ? <Spinner /> : <Play className="size-4" />}
                {done === 0 ? "Start attack" : done === visible.length ? "All blocked" : "Continue"}
              </button>
            </div>
            <div ref={consoleRef} className="max-h-[560px] space-y-5 overflow-y-auto p-5 font-mono text-sm">
              {visible.map((a, i) => {
                const st = state.attacks[a.key];
                return (
                  <div key={a.key} className={cx("space-y-1", st === "idle" && "opacity-40")}>
                    <p className="text-white/50">
                      # {i + 1}. {a.title} {a.quantum && <Atom className="inline size-4 text-[#b6a0ff]" />}
                    </p>
                    <p className="break-all text-[#f3b43f]">$ {a.cmd}</p>
                    {st === "running" && (
                      <p className="inline-flex items-center gap-2 text-white/60">
                        <Spinner className="size-3" /> Sending tx…
                      </p>
                    )}
                    {st === "blocked" && (
                      <div className="animate-fade-up space-y-1">
                        {a.quantum && qdayResult && <p className="text-[#b6a0ff]">{qdayResult}</p>}
                        <p className="font-bold text-[#ff7a6b]">
                          ✗ Rejected on-chain · {a.error.code} {a.error.name}
                        </p>
                        <p className="text-white/50">Why: {a.rule}</p>
                      </div>
                    )}
                  </div>
                );
              })}
              {done === visible.length && !state.revoked && (
                <p className="animate-fade-up text-[#5bd69a]">
                  {visible.length} attacks, 0 succeeded. Next: revoke the agent with one signature.
                </p>
              )}
              {state.revoked && state.attacks.revoked === "blocked" && (
                <p className="animate-fade-up text-[#5bd69a]">Revoked. The old key has no power left.</p>
              )}
            </div>
            <p className="border-t border-night-line px-5 py-3 text-xs text-white/40">
              Error codes from QoreChain docs. Transactions are simulated; the Q-Day signature check runs for real.
            </p>
          </div>

          {/* Victim side */}
          <aside className="space-y-4">
            <div className="rounded-2xl border border-night-line bg-night-2 p-5">
              <p className="text-sm text-white/60">Your wallet</p>
              <p className="tabular mt-1 text-4xl font-black">{usd(balance)}</p>
              <p className="text-sm text-white/60">fUSD · {shortAddr(ADDRESSES.owner, 8, 4)}</p>
              <div className="mt-4 rounded-xl bg-[#5bd69a]/10 px-3 py-2 text-sm text-[#5bd69a]">Attacker took: US$0</div>
            </div>

            <div className="rounded-2xl border border-night-line bg-night-2 p-5">
              <p className="text-sm text-white/60">Agent key</p>
              <p className={cx("mt-1 inline-flex items-center gap-2 text-lg font-bold", state.revoked ? "text-[#ff7a6b]" : "text-white")}>
                {state.revoked ? <ShieldOff className="size-5" /> : <KeyRound className="size-5" />}
                {state.revoked ? "Revoked" : "Still valid (leaked)"}
              </p>
              <p className="mt-1 font-mono text-xs text-white/50">{shortAddr(ADDRESSES.agent, 10, 6)}</p>
              {!state.revoked ? (
                <button
                  type="button"
                  onClick={() => setWalletOpen(true)}
                  disabled={done < attacks.length}
                  className="mt-4 w-full rounded-xl bg-white py-3 text-sm font-bold text-night hover:bg-white/90 disabled:bg-white/10 disabled:text-white/40"
                >
                  Revoke agent (ML-DSA-87)
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => runOne(afterRevoke)}
                  disabled={state.attacks.revoked !== "idle"}
                  className="mt-4 w-full rounded-xl border border-white/20 py-3 text-sm font-bold text-white hover:bg-white/5 disabled:text-white/40"
                >
                  Attack again with old key
                </button>
              )}
              {done < attacks.length && !state.revoked && <p className="mt-2 text-xs text-white/40">Run the attacks first.</p>}
            </div>

            <div className="rounded-2xl border border-night-line bg-night-2 p-5 text-sm text-white/70">
              <p className="mb-2 inline-flex items-center gap-2 font-bold text-white">
                <ShieldCheck className="size-4 text-[#5bd69a]" /> Why it holds
              </p>
              <ul className="space-y-2">
                <li>Rules live on-chain, not in the agent.</li>
                <li>Changing them takes your quantum-safe ML-DSA-87 key.</li>
                <li>Agent money only goes to escrow, paid out on ticket.</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>

      {walletOpen && (
        <WalletModal
          open
          danger
          title="Revoke agent key"
          summary={[
            { k: "Action", v: "MsgRevokeAuthenticator" },
            { k: "agent", v: shortAddr(ADDRESSES.agent, 9, 4) },
            { k: "Effect", v: "Loses all access now" },
          ]}
          steps={[{ label: "Sign revocation with ML-DSA-87" }, { label: "Send MsgRevokeAuthenticator" }]}
          runStep={async (i) => {
            if (i === 0) {
              const r = await signAsOwner({ action: "revokeAuthenticator", agent: ADDRESSES.agent, owner: ADDRESSES.owner });
              return `${r.sigBytes.toLocaleString()} bytes · ${r.ms} ms`;
            }
            await wait(700);
            const tx = makeTx("Revoke agent key", "MsgRevokeAuthenticator", "owner");
            addTx(tx);
            return `${tx.hash.slice(0, 14)}…`;
          }}
          onDone={() => {
            update((s) => ({ ...s, revoked: true }));
            setWalletOpen(false);
          }}
          onClose={() => setWalletOpen(false)}
        />
      )}
    </div>
  );
}

function Score({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div className="min-w-24 rounded-xl border border-night-line bg-night-2 px-4 py-3">
      <p className={cx("tabular text-2xl font-black", tone === "ok" ? "text-[#5bd69a]" : "text-white")}>{value}</p>
      <p className="text-xs text-white/50">{label}</p>
    </div>
  );
}
