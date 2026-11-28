"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, Wallet } from "lucide-react";
import { ADDRESSES, CHAIN, liveOwner, shortAddr, type OwnerState } from "@/lib/chain";
import { connectQorex, QOREX_INSTALL_URL, WalletUnavailable } from "@/lib/qorex";
import { useDemo } from "@/lib/store";
import { cx } from "./ui";

/** How often the connected owner's balance and budget are read again. */
const REFRESH_MS = 30_000;

/**
 * The header's wallet. Simulated: the demo account. Live: "Connect QoreX", then the owner's
 * account, its QOR balance and the budget held for FlyGate's agent, read from diana.
 */
export function WalletButton() {
  const { state, update } = useDemo();
  const [error, setError] = useState<{ text: string; install?: boolean } | undefined>();
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<OwnerState | undefined>();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const live = state.mode === "live";
  const wallet = live ? state.wallet : undefined;

  const refresh = useCallback(async () => {
    if (!wallet) return;
    setAccount(await liveOwner.state(wallet));
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    // Reading diana is an external system; the result lands in state when it arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [wallet, refresh, state.txs.length]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function connect() {
    setBusy(true);
    setError(undefined);
    try {
      const owner = await connectQorex(CHAIN.chainId);
      update((s) => ({ ...s, wallet: owner }));
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : String(err), install: err instanceof WalletUnavailable && /not installed/.test(String(err)) });
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    setOpen(false);
    setAccount(undefined);
    update((s) => ({ ...s, wallet: undefined }));
  }

  if (!live) {
    const signed = Boolean(state.signed);
    return (
      <span className={cx("inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium", signed ? "bg-brand-50 text-brand" : "bg-canvas text-ink-2")}>
        <Wallet className="size-4" />
        {signed ? shortAddr(ADDRESSES.owner, 7, 4) : "Wallet not connected"}
      </span>
    );
  }

  if (!wallet) {
    return (
      <span className="relative">
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-600 disabled:opacity-60"
        >
          <Wallet className="size-4" />
          {busy ? "Connecting…" : "Connect QoreX"}
        </button>
        {error && (
          <span role="alert" className="absolute top-full right-0 z-50 mt-2 w-72 rounded-xl border border-line bg-white p-3 text-xs text-ink-2 shadow-lg">
            {error.text}
            {error.install && (
              <a href={QOREX_INSTALL_URL} target="_blank" rel="noreferrer" className="mt-2 block font-bold text-brand hover:underline">
                Get QoreX
              </a>
            )}
          </span>
        )}
      </span>
    );
  }

  const info = account?.ok ? account : undefined;
  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand"
        title={wallet}
      >
        <Wallet className="size-4" />
        {shortAddr(wallet, 7, 4)}
        {info && <span className="text-ink-2">· {info.balanceQor} QOR</span>}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-80 space-y-2 rounded-xl border border-line bg-white p-4 text-xs text-ink-2 shadow-lg">
          <p className="font-mono break-all text-ink">{wallet}</p>
          {info && <p className="font-mono break-all text-muted">{info.owner.evm}</p>}
          {account && !account.ok && <p className="text-block">{account.reason}</p>}
          {info && (
            <dl className="space-y-1 border-t border-line pt-2">
              <div className="flex justify-between">
                <dt>Wallet balance</dt>
                <dd className="font-bold text-ink">{info.balanceQor} QOR</dd>
              </div>
              <div className="flex justify-between">
                <dt>Budget held for the agent</dt>
                <dd className="font-bold text-ink">{info.mandate && !info.mandate.revoked ? `${info.mandate.budgetQor} QOR` : "none"}</dd>
              </div>
            </dl>
          )}
          <button type="button" onClick={disconnect} className="inline-flex items-center gap-1.5 font-bold text-brand hover:underline">
            <LogOut className="size-3.5" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
