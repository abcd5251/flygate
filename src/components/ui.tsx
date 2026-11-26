"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children, id }: { className?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className={cx("rounded-2xl border border-line bg-white shadow-card", className)}>
      {children}
    </section>
  );
}

type Tone = "brand" | "pass" | "block" | "warn" | "pq" | "muted";

const TONES: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand border-brand-100",
  pass: "bg-pass-50 text-pass border-pass/20",
  block: "bg-block-50 text-block border-block/20",
  warn: "bg-warn-50 text-warn border-warn/20",
  pq: "bg-pq-50 text-pq border-pq/20",
  muted: "bg-canvas text-ink-2 border-line",
};

export function Pill({ tone = "muted", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

/**
 * Where a value came from: real crypto computed in the browser, a live tx on diana, a live
 * read-only query (eth_call / REST), or a simulated chain transaction.
 */
export type SourceKind = "crypto" | "live-tx" | "live-read" | "simulated";

const SOURCE_TAGS: Record<SourceKind, { tone: Tone; label: string }> = {
  crypto: { tone: "pq", label: "Real crypto" },
  "live-tx": { tone: "pass", label: "Live tx · diana" },
  "live-read": { tone: "brand", label: "Live read" },
  simulated: { tone: "muted", label: "Simulated tx" },
};

export function SourceTag({ kind }: { kind: SourceKind }) {
  const t = SOURCE_TAGS[kind];
  return <Pill tone={t.tone}>{t.label}</Pill>;
}

export const EXPLORER_TOOLTIP = "Explorer: switch to Testnet";

export function HashText({
  value,
  className,
  head = 10,
  tail = 6,
  explorerUrl,
}: {
  value: string;
  className?: string;
  head?: number;
  tail?: number;
  /** When set, the hash links to the explorer; copying stays available next to it. */
  explorerUrl?: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  const icon = copied ? <Check className="size-3 text-pass" /> : <Copy className="size-3 opacity-60" />;
  if (explorerUrl) {
    return (
      <span className={cx("inline-flex items-center gap-1 font-mono text-xs text-ink-2", className)}>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer" title={EXPLORER_TOOLTIP} className="tabular text-brand underline-offset-2 hover:underline">
          {short}
        </a>
        <button type="button" onClick={copy} title="Copy" aria-label="Copy hash" className="hover:text-brand">
          {icon}
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className={cx("inline-flex items-center gap-1 font-mono text-xs text-ink-2 hover:text-brand", className)}
    >
      <span className="tabular">{short}</span>
      {icon}
    </button>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-6 py-3 text-base font-bold text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:bg-muted/60",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl border border-brand bg-white px-5 py-2.5 text-sm font-bold text-brand transition hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:border-line disabled:text-muted",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)} aria-hidden />;
}
