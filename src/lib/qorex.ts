import type { WalletRequest } from "./chain";

/**
 * The owner's QoreX wallet, in the browser (ADR-0003). QoreX injects `window.qorex.native`; the
 * page asks it for the active account and hands it whole transactions to show, sign (hybrid
 * secp256k1 + ML-DSA-87) and broadcast. The page never sees a key. Shapes follow
 * `@qorechain/qorex-types` (QoreX extension 0.3.5+, app 1.1.5+).
 *
 * What QoreX cannot do for a page today, and the design relies on none of it: sign arbitrary
 * messages (`signArbitrary` is refused), sign EVM transactions, or send account-authority
 * messages (authenticators, spending rules, EVM windows).
 */

export const QOREX_INSTALL_URL = "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg";
const SIGN_AND_BROADCAST = "signAndBroadcast";

type QorexKey = { bech32Address: string; pubKeyHex?: string };
type QorexResult = { txHash: string; code: number; height?: number; shield: string };
interface QorexNative {
  readonly isQoreX: true;
  readonly capabilities: readonly string[];
  enable(chainId: string): Promise<void | null>;
  getKey(chainId: string): Promise<QorexKey>;
  signAndBroadcast(request: { chainId: string; messages: { typeUrl: string; value: string }[]; memo?: string; gasLimit?: number }): Promise<QorexResult>;
}

declare global {
  interface Window {
    qorex?: { native?: QorexNative };
  }
}

/** Why the wallet cannot be used, in words the person can act on. */
export class WalletUnavailable extends Error {}

/** QoreX, when it is installed and new enough to sign and broadcast. */
function native(): QorexNative {
  const n = typeof window === "undefined" ? undefined : window.qorex?.native;
  if (!n?.isQoreX) throw new WalletUnavailable("QoreX is not installed in this browser. Install the QoreX extension, or open FlyGate in the QoreX app.");
  if (!n.capabilities?.includes(SIGN_AND_BROADCAST)) throw new WalletUnavailable("This QoreX version cannot sign QoreChain transactions for websites. Update QoreX (extension 0.3.5 or later).");
  return n;
}

export function hasQorex(): boolean {
  try {
    native();
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect FlyGate to QoreX on `chainId` (QoreX asks the person once per site) and return the
 * active account's qor1 address. The page cannot switch QoreX's network: on the wrong one this
 * throws and the person switches in QoreX.
 */
export async function connectQorex(chainId: string): Promise<string> {
  const n = native();
  try {
    await n.enable(chainId);
    const key = await n.getKey(chainId);
    return key.bech32Address;
  } catch (err) {
    throw walletError(err, chainId);
  }
}

/** The person declined in QoreX: not a failure to report as an error. */
export function isRejection(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /signature rejected|user rejected|request rejected|rejected by user/i.test(text);
}

function walletError(err: unknown, chainId: string): Error {
  if (err instanceof WalletUnavailable) return err;
  const text = err instanceof Error ? err.message : String(err);
  if (/unsupported chain|unrecognized chain|network/i.test(text)) return new WalletUnavailable(`Switch QoreX to ${chainId} (testnet) and try again. (${text})`);
  return err instanceof Error ? err : new Error(text);
}

/**
 * Show `request` in QoreX for the person to approve; QoreX signs and broadcasts it. Resolves with
 * the tx hash once broadcast (code 0); throws on a refusal by the chain, and with a rejection
 * (see `isRejection`) when the person declines.
 */
export async function signAndBroadcast(request: WalletRequest): Promise<{ txHash: string; shield: string }> {
  const n = native();
  let r: QorexResult;
  try {
    r = await n.signAndBroadcast({ chainId: request.chainId, messages: request.messages, memo: request.memo, gasLimit: request.gasLimit });
  } catch (err) {
    throw walletError(err, request.chainId);
  }
  if (r.code !== 0) throw new Error(`The chain refused the transaction (code ${r.code}, tx ${r.txHash})`);
  return { txHash: r.txHash, shield: r.shield };
}

/**
 * A fresh session key: 32 random bytes the browser keeps. Its hash goes into the on-chain
 * mandate; the server lets the agent act for this owner only when a request presents the key.
 */
export function newSessionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
