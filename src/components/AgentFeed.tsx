"use client";

import { Bot, Link2, ShieldCheck, Store } from "lucide-react";
import type { FeedItem } from "@/lib/types";
import { cx, Spinner } from "./ui";

const WHO = {
  agent: { label: "Agent", icon: Bot, color: "text-brand bg-brand-50" },
  gate: { label: "Gate", icon: ShieldCheck, color: "text-pass bg-pass-50" },
  merchant: { label: "Merchant", icon: Store, color: "text-[#0e9384] bg-[#e6f6f4]" },
  chain: { label: "Chain", icon: Link2, color: "text-pq bg-pq-50" },
} as const;

/** Live log of what the agent is doing; makes "AI ranks, code decides" visible. */
export function AgentFeed({ items, busy, title = "Agent activity" }: { items: FeedItem[]; busy: boolean; title?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <p className="inline-flex items-center gap-2 font-bold text-ink">
          <span className="relative flex size-2.5">
            {busy && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />}
            <span className={cx("relative inline-flex size-2.5 rounded-full", busy ? "bg-brand" : "bg-pass")} />
          </span>
          {title}
        </p>
        {busy && <Spinner className="text-brand" />}
      </div>
      <ol className="max-h-[420px] space-y-3 overflow-y-auto p-4" aria-live="polite">
        {items.length === 0 && <li className="text-sm text-muted">Waiting…</li>}
        {items.map((it) => {
          const w = WHO[it.who];
          const Icon = w.icon;
          return (
            <li key={it.id} className="flex animate-fade-up gap-3 text-sm">
              <span className={cx("grid size-7 shrink-0 place-items-center rounded-full", w.color)}>
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] text-muted">
                  {w.label} · {new Date(it.at).toLocaleTimeString("en-GB")}
                </p>
                <p
                  className={cx(
                    "text-ink",
                    it.tone === "block" && "text-block",
                    it.tone === "pass" && "text-pass",
                    it.tone === "pick" && "font-bold text-brand",
                  )}
                >
                  {it.text}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
