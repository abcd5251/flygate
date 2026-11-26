import "server-only";

/**
 * The abstractaccount REST query answers 404 "account <addr> not found" until the account's first
 * link creates it (linkAuthenticatorMsgs with account == owner). The SDK throws a plain Error, so
 * this matches its message: `abstractaccount query failed: HTTP 404 from <url>: account <addr> not found`.
 * Any other 404 (an older node without the endpoint) stays an error.
 */
export function isAccountNotFound(err: unknown): boolean {
  return err instanceof Error && /HTTP 404 from \S+: account \S+ not found$/.test(err.message);
}

/** Reads an account's linked keys; an account with no abstract-account record has none. */
export async function linkedKeysOrNone<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    if (isAccountNotFound(err)) return [];
    throw err;
  }
}
