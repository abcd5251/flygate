"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { sleep } from "./chain";
import { defaultMandate, defaultPassenger } from "./mandate";
import type {
  AgentRun,
  AttackKey,
  AttackState,
  Booking,
  ChainTx,
  EncryptedPassenger,
  Mandate,
  PassengerInput,
  Scenario,
  SignedMandate,
} from "./types";

export type DemoState = {
  scenario: Scenario;
  speed: 1 | 2;
  draft: Mandate;
  intentText: string;
  passengerInput: PassengerInput;
  signed?: SignedMandate;
  passenger?: EncryptedPassenger;
  agent?: AgentRun;
  booking?: Booking;
  spentUsd: number;
  refundedUsd: number;
  revoked: boolean;
  attacks: Record<AttackKey, AttackState>;
  txs: ChainTx[];
};

const STORAGE_KEY = "flygate-demo-v1";

const IDLE_ATTACKS: Record<AttackKey, AttackState> = {
  overspend: "idle",
  drain: "idle",
  replay: "idle",
  expired: "idle",
  qday: "idle",
  revoked: "idle",
};

function initialState(): DemoState {
  return {
    scenario: "normal",
    speed: 1,
    draft: defaultMandate(),
    intentText: "",
    passengerInput: defaultPassenger(),
    spentUsd: 0,
    refundedUsd: 0,
    revoked: false,
    attacks: { ...IDLE_ATTACKS },
    txs: [],
  };
}

/**
 * Fills defaults for fields older saved sessions lack: top-level fields from `initialState()`,
 * and `source` on chain txs (everything saved before Live mode existed was simulated).
 */
function restoreState(saved: Partial<DemoState>): DemoState {
  const base = { ...initialState(), ...saved };
  return {
    ...base,
    txs: (Array.isArray(base.txs) ? base.txs : []).map((t) => ({ ...t, source: t.source ?? "simulated" })),
  };
}

type Ctx = {
  state: DemoState;
  ready: boolean;
  update: (fn: (s: DemoState) => DemoState) => void;
  latest: () => DemoState;
  wait: (ms: number) => Promise<void>;
  addTx: (tx: ChainTx) => void;
  reset: () => void;
};

const DemoContext = createContext<Ctx | null>(null);

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState>(initialState);
  const [ready, setReady] = useState(false);
  const ref = useRef(state);

  useEffect(() => {
    ref.current = state;
  }, [state]);

  useEffect(() => {
    let restored: DemoState | undefined;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) restored = restoreState(JSON.parse(raw) as Partial<DemoState>);
    } catch {
      restored = undefined;
    }
    // Restoring from sessionStorage has to happen after hydration to avoid a server/client mismatch.
    if (restored) {
      ref.current = restored;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState(restored);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage can be unavailable; the demo still works in memory */
    }
  }, [state, ready]);

  // Apply updates to the ref synchronously so async runners that call latest()
  // right after update() see the new state, not the last rendered one.
  const update = useCallback((fn: (s: DemoState) => DemoState) => {
    const next = fn(ref.current);
    ref.current = next;
    setState(next);
  }, []);

  const latest = useCallback(() => ref.current, []);
  const wait = useCallback((ms: number) => sleep(ms / ref.current.speed), []);
  const addTx = useCallback((tx: ChainTx) => update((s) => ({ ...s, txs: [tx, ...s.txs].slice(0, 40) })), [update]);
  const reset = useCallback(() => {
    const fresh = initialState();
    ref.current = fresh;
    setState(fresh);
  }, []);

  const value = useMemo(() => ({ state, ready, update, latest, wait, addTx, reset }), [state, ready, update, latest, wait, addTx, reset]);
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemo must be used inside DemoProvider");
  return ctx;
}
