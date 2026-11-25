# Coding standards

Rules a review enforces. Each one comes from a bug or review finding in this repo.

- **Idempotency keys must be unique by construction.** A content hash alone can collide (two quotes for the same offer in the same second shared a bookingId, so the second `lock` hit the first one's cache).
- **Never retry a broadcast; retry only reads and connecting.** A resent transaction is a second payment.
- **`src/server/live/**` starts with `import "server-only"`.** Keys and `@qorechain/sdk` never reach the client bundle; `pnpm check:bundle` checks the build.
- **Labels follow the data's `source`.** Show `Live tx`, `Live read`, `Simulated tx` or `Real crypto` from the step's `source`/`hash`; never hard-code a label for a step that can be either.
- **Shared helpers live in a shared module.** Don't copy a private function into a second file; export it from one place.
