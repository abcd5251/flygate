"use client";

import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, ShieldCheck, X } from "lucide-react";
import { ADDRESSES, shortAddr } from "@/lib/chain";
import { useDemo } from "@/lib/store";
import { cx, Spinner } from "./ui";

export type WalletStep = { label: string; detail?: string };

type Props = {
  open: boolean;
  title: string;
  summary: Array<{ k: string; v: string }>;
  steps: WalletStep[];
  /** Runs one step; resolves with an optional detail string shown under the step. */
  runStep: (index: number) => Promise<string | void>;
  onDone: () => void;
  onClose: () => void;
  danger?: boolean;
};

/** Simulated QoreX wallet. Signing steps call real ML-DSA / ML-KEM code via runStep. */
export function WalletModal({ open, title, summary, steps, runStep, onDone, onClose, danger }: Props) {
  const [phase, setPhase] = useState<"review" | "signing" | "done">("review");
  const [progress, setProgress] = useState(0);
  const [details, setDetails] = useState<Record<number, string>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const { setSigning } = useDemo();

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  // Lets the presenter panel lock the Live/Simulated switch while a signature is in progress.
  useEffect(() => {
    if (!open) return;
    setSigning(true);
    return () => setSigning(false);
  }, [open, setSigning]);

  if (!open) return null;

  async function sign() {
    setPhase("signing");
    for (let i = 0; i < steps.length; i++) {
      setProgress(i);
      const detail = await runStep(i);
      if (detail) setDetails((d) => ({ ...d, [i]: detail }));
    }
    setProgress(steps.length);
    setPhase("done");
    setTimeout(onDone, 700);
  }

  function close() {
    if (phase === "signing") return;
    setPhase("review");
    setProgress(0);
    setDetails({});
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4" role="presentation" onClick={close}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="w-full max-w-md animate-pop overflow-hidden rounded-2xl bg-white shadow-float outline-none"
      >
        <div className="flex items-center justify-between bg-night px-5 py-3 text-white">
          <span className="inline-flex items-center gap-2 text-sm font-bold">
            <span className="grid size-6 place-items-center rounded-md bg-pq text-[11px] font-black">Q</span>
            QoreX Wallet
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/70">Simulated</span>
          </span>
          <button type="button" onClick={close} aria-label="Close" className="text-white/60 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs text-muted">flygate.app requests a signature</p>
            <h2 className="mt-1 text-lg font-bold text-ink">{title}</h2>
            <p className="mt-1 font-mono text-xs text-ink-2">Account {shortAddr(ADDRESSES.owner, 10, 6)}</p>
          </div>

          <dl className="divide-y divide-line rounded-xl border border-line text-sm">
            {summary.map((row) => (
              <div key={row.k} className="flex justify-between gap-4 px-3 py-2">
                <dt className="text-muted">{row.k}</dt>
                <dd className="text-right font-medium text-ink">{row.v}</dd>
              </div>
            ))}
          </dl>

          <div className="flex items-start gap-3 rounded-xl bg-pq-50 p-3 text-xs text-pq">
            <KeyRound className="mt-0.5 size-4 shrink-0" />
            <p>
              Hybrid signature: secp256k1 + <b>ML-DSA-87</b> (FIPS 204). Breaking the first one isn&apos;t enough to impersonate you.
            </p>
          </div>

          {phase !== "review" && (
            <ol className="space-y-2" aria-live="polite">
              {steps.map((s, i) => {
                const done = i < progress;
                const running = i === progress && phase === "signing";
                return (
                  <li key={s.label} className="flex items-start gap-2 text-sm">
                    <span className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", done ? "bg-pass text-white" : "bg-canvas text-muted")}>
                      {done ? <Check className="size-3" strokeWidth={3} /> : running ? <Spinner className="size-3 text-brand" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className={cx(done || running ? "text-ink" : "text-muted")}>{s.label}</span>
                      {(details[i] || s.detail) && <span className="block font-mono text-[11px] text-muted">{details[i] ?? s.detail}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={close}
              disabled={phase === "signing"}
              className="flex-1 rounded-xl border border-line py-3 text-sm font-bold text-ink-2 hover:bg-canvas disabled:opacity-40"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={sign}
              disabled={phase !== "review"}
              className={cx(
                "flex flex-[2] items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold text-white transition disabled:opacity-90",
                danger ? "bg-block hover:bg-block/90" : "bg-brand hover:bg-brand-600",
              )}
            >
              {phase === "review" && (
                <>
                  <ShieldCheck className="size-4" /> Sign
                </>
              )}
              {phase === "signing" && (
                <>
                  <Spinner /> Signing
                </>
              )}
              {phase === "done" && (
                <>
                  <Check className="size-4" /> Done
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
