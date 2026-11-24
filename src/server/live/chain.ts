import "server-only";
import type { PqcKeyStatus } from "../../../scripts/evm/pqcKeyStatus";

export type Hex = `0x${string}`;
export type { PqcKeyStatus };

/**
 * The server-side chain interface the Live service depends on: everything it reads from (and,
 * from #20 on, sends to) diana. `createDianaChain` is the real one; tests use `FakeChain`.
 * Implementations retry reads on rate limiting only, and never retry a broadcast.
 */
export interface ServerChain {
  /** eth_chainId. */
  evmChainId(): Promise<number>;
  /** eth_getCode at latest; "0x" when nothing is deployed. */
  getCode(address: Hex): Promise<Hex>;
  /** pqcKeyStatus(address) on the 0x...0A02 precompile, as FlightEscrow reads it. */
  pqcKeyStatus(address: Hex): Promise<PqcKeyStatus>;
  /** Bank balance in uqor of a qor1 account. */
  bankBalance(cosmos: string): Promise<bigint>;
  /** EVM balance in wei of a 0x address. */
  evmBalance(address: Hex): Promise<bigint>;
}
