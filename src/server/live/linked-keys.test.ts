import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccountNotFound, linkedKeysOrNone } from "./linked-keys";

const OWNER = "qor1rg4wqdyez5c22aw0qkcrvtn7zhmhnpwq5qp835";
const URL = `https://api-testnet.qore.host/qorechain/abstractaccount/v1/accounts/${OWNER}/authenticators`;
// The SDK's message for a 404 (fetchAuthenticators, @qorechain/sdk 0.14.0).
const notFound = new Error(`abstractaccount query failed: HTTP 404 from ${URL}: account ${OWNER} not found`);

test("an account with no abstract-account record has no linked keys", async () => {
  assert.equal(isAccountNotFound(notFound), true);
  assert.deepEqual(await linkedKeysOrNone(() => Promise.reject(notFound)), []);
});

test("linked keys pass through when the account exists", async () => {
  const keys = [{ pubkeyHex: "7e59bc2", revoked: false, expiryUnix: 1 }];
  assert.deepEqual(await linkedKeysOrNone(() => Promise.resolve(keys)), keys);
});

test("a 404 without 'account … not found' (endpoint missing) stays an error", async () => {
  const missing = new Error(`abstractaccount query failed: HTTP 404 from ${URL}: Not Found`);
  assert.equal(isAccountNotFound(missing), false);
  await assert.rejects(linkedKeysOrNone(() => Promise.reject(missing)), missing);
});

test("other HTTP errors stay errors", async () => {
  const down = new Error(`abstractaccount query failed: HTTP 503 from ${URL}: account ${OWNER} not found`);
  assert.equal(isAccountNotFound(down), false);
  await assert.rejects(linkedKeysOrNone(() => Promise.reject(down)), down);
  assert.equal(isAccountNotFound("account not found"), false);
});
