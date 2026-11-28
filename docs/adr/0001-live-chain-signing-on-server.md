---
status: superseded
---

# Live mode signs every chain transaction on the Next.js server

Status: Superseded by ADR-0003 (the owner signs with their own QoreX wallet; FlyGate never holds an owner key)

In Live mode, every QoreChain diana transaction is signed and broadcast by Next.js Route Handlers (`src/app/api/live/*`, modules marked `server-only`). This covers the owner's authenticator link, window, and mandate, the agent's `MsgExecuteEVM` booking, and the merchant's ticket and cancel proofs. The keys are derived from the per-role mnemonics in the server-side `.env.local`. The browser never imports `@qorechain/sdk` and never sees key material. The owner has no real QoreX wallet integration, so the only way to sign in the browser would be to ship the owner mnemonic to it. A script-driven flow with recorded hashes would not be live. A server signer also keeps the 2.9 MB SDK out of the client bundle. Consequence: the server becomes a signing oracle, so Live routes are off unless `LIVE_MODE=on`, run only on the presenter's machine, and build all calldata themselves (live-checkout/D-08).
