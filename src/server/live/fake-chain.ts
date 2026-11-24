import "server-only";
import type { Hex, PqcKeyStatus, ServerChain } from "./chain";

export type FakeCall = { method: keyof ServerChain; args: unknown[] };

export interface FakeChainState {
  chainId: number;
  /** Code per lowercase address; missing means "0x". */
  code: Record<string, Hex>;
  /** pqcKeyStatus per lowercase address; missing means not registered. */
  pqc: Record<string, PqcKeyStatus>;
  /** uqor per qor1 address. */
  bank: Record<string, bigint>;
  /** wei per lowercase 0x address. */
  evm: Record<string, bigint>;
  /** Make a method throw this error (an RPC failure). */
  fail: Partial<Record<keyof ServerChain, Error>>;
}

const NOT_REGISTERED: PqcKeyStatus = { registered: false, algorithmId: 0, pubkey: new Uint8Array(), possessionProven: false };

/**
 * Test double for the server-side chain interface. Records every call in order, answers from
 * `state`, and can be told to fail a method. Broadcasts (and their success / revert / timeout /
 * execution-failed outcomes) are added with the operations that send them (#20 on).
 */
export class FakeChain implements ServerChain {
  readonly calls: FakeCall[] = [];
  readonly state: FakeChainState;

  constructor(state: Partial<FakeChainState> = {}) {
    this.state = { chainId: 9800, code: {}, pqc: {}, bank: {}, evm: {}, fail: {}, ...state };
  }

  private record(method: keyof ServerChain, args: unknown[]) {
    this.calls.push({ method, args });
    const err = this.state.fail[method];
    if (err) throw err;
  }

  callsTo(method: keyof ServerChain): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async evmChainId() {
    this.record("evmChainId", []);
    return this.state.chainId;
  }
  async getCode(address: Hex) {
    this.record("getCode", [address]);
    return this.state.code[address.toLowerCase()] ?? "0x";
  }
  async pqcKeyStatus(address: Hex) {
    this.record("pqcKeyStatus", [address]);
    return this.state.pqc[address.toLowerCase()] ?? NOT_REGISTERED;
  }
  async bankBalance(cosmos: string) {
    this.record("bankBalance", [cosmos]);
    return this.state.bank[cosmos] ?? BigInt(0);
  }
  async evmBalance(address: Hex) {
    this.record("evmBalance", [address]);
    return this.state.evm[address.toLowerCase()] ?? BigInt(0);
  }
}
