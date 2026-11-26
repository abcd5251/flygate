# live-checkout code review

- Range: `c803f86..HEAD` before the review commit (T#17–T#25: 1ba8330, 19f2099, 7144f41, 9b0bcd6, 7c2c055, 03191c4, d7ce105, 078d0b4, 53c6c17). c803f86 itself (merge of another feature) is not reviewed.
- Spec: issue #16 / `docs/features/live-checkout/spec.md`, tickets #17–#25, `decisions.md` (D-01…D-34). Part B (#26, real diana run) is out of scope: it waits for the FlightEscrow deployment (#14).
- Standards sources: `AGENTS.md`, `GLOSSARY.md`, `docs/adr/0001-*`, `docs/adr/0002-*`, the implementer brief's rules, and the Fowler smell baseline (judgement calls only).
- Both axes were reviewed in one pass by the reviewing agent and are reported separately.

## Standards

| # | Finding | Kind | Status |
|---|---|---|---|
| S-1 | **Duplicated Code**: `scripts/live/probe.ts` kept private copies of `accountSequence`, `restBroadcaster`, `sendEthNative`, the PQC registration and window-opening code, and the gas constants that T#25 moved into `scripts/live/eth-native.ts`. The brief said "reuse eth-native.ts, don't copy again". | judgement (also a brief rule) | **Fixed**: probe.ts now calls `registerSignerPqc` / `openSignerWindow` through a small `ethNative(ctx)` adapter; `openSignerWindow` takes `allowedTargets` as optional (probe's signer window had none). |
| S-2 | **Divergent Change** in `src/app/checkout/page.tsx`: the Booking fails refund (cancel + balance read + budget update) lived inside the `order` case, so the order step changed for two reasons and the refund could not be resumed or recovered on its own (see P-2). | judgement | **Fixed**: `refund` is its own `case` in `run()`; the order step only fails and queues the refund step. |
| S-3 | **Repeated Switches**: the dispatcher in `src/server/live/checkout.ts` inlines the `farecap` case (quote lookup + `fareCapCheck`) while every other step is a named function. | judgement | Open: cosmetic, no behaviour change. |
| S-4 | **Primitive Obsession**: step names travel as strings (`"lock"`, `"proof"`, …) between client, route and server, with `CHECKOUT_STEPS` as the only guard. | judgement | Open: the route validates the string against `CHECKOUT_STEPS`; a shared type would touch every ticket's code. |

No documented-standard violations found: every `src/server/live/*.ts` module starts with `import "server-only"`; there is no `NEXT_PUBLIC_` key, no `console.*` in server code, `.env*` is git-ignored except `.env.example` (names only).

## Spec

| # | Finding | Spec / decision | Status |
|---|---|---|---|
| P-1 | **bookingId collision**: `bookingId = keccak256(abi.encode(quote))` and the quote has no nonce. Two quotes for the same offer in the same second (Ticketed, then Booking fails, which has the same price) got the same id, so the second booking overwrote the first's server-side quote and its `lock` was answered from the first booking's idempotency cache: nothing was sent. | §4.9 "以 `(step, bookingId)` 為 key 存冪等表" (D-28) | **Fixed**: `quote()` moves `expiresAt` on by one second until the id is new to this server (the contract's Quote has no other free field). Test added in `checkout.test.ts`. |
| P-2 | **Refund step not recoverable, and "Finish in Simulated mode" broke it** (T#23 × T#24 merge). (a) A reload during the refund left it "running" forever: the runner stopped at the order step's scenario failure. (b) After a failed Live `cancel()`, "Finish in Simulated mode" picked the *first* failed step, i.e. the scenario's order failure: it re-ran the order step, appended a second `refund` step with the same key, and the fallback callout blamed "Merchant books with Duffel". | §3 #38, #48; §4.8, §4.9 (D-26, D-28) | **Fixed**: `refund` added to `RECOVERABLE` (a `Refunded` event marks it done with its hash; `Locked` re-asks the server, whose idempotency table answers a repeat); one `stopsRun` predicate (any failed step except the order step) is used by the runner, the failure callout and `finishSimulated`, so the fallback resumes the refund step. |
| P-3 | **Duplicated message**: T#23's failed-cancel detail ended with "booking 0x…: refunds after the ticket window" while T#24's callout shows the same bookingId and hint (`EscrowNotice`) right above it. | §4.8 (D-26) | **Fixed**: the step keeps only the chain error; the callout carries the bookingId and the hint. |
| P-4 | `/ticket` Proofs note in Live said "Escrow payment and payout are transactions on the diana testnet" whenever *either* row was live; after a fallback the payout is simulated. | §4.7, §3 #29 (D-21) | **Fixed**: "Rows tagged “Live tx · diana” are transactions on the diana testnet; the rest are simulated." |
| P-5 | Hard-coded "Simulated tx": none left on a step that can be live (request.md completion criterion holds). In pure Simulated mode, `/checkout` hashed steps and `/mandate` owner txs show no "Simulated tx" tag (only the sidebar note says so); after a fallback they do. | §3 #26 | Open (judgement): the pre-feature screens had no tag there either and the spec asks screens to change as little as possible. |
| P-6 | Secrets: no mnemonic or key reaches the client bundle (`check:bundle` passes), logs or git. Residual risk: `errorText(err)` from RPC/SDK errors is returned in API `reason` fields; no SDK path seen that echoes a mnemonic. | §4.2 (D-07) | Open (low risk, noted). |
| P-7 | Quotes and the idempotency table live in server memory (as specified). After a server restart a reload still recovers from chain events, but a step whose booking is still `Locked` gets "unknown booking" (nothing sent) and needs "Finish in Simulated mode"; the funds are swept by `pnpm live:sweep`. | §4.9 (D-28) | Open: as specified. |
| P-8 | Unverified assumptions carried into Part B: `MAX_FEE_UQOR` (D-27), `BOOK_GAS_LIMIT`, and everything `pnpm live:probe` must confirm (D-09, D-10, D-12, D-13, D-19, D-23, D-32). | D-01 | Open: Part B (#26). |

## Summary

Standards: 4 findings (2 fixed, 2 open judgement calls); worst was the probe/eth-native duplication. Spec: 8 findings (4 fixed, 4 open by design or out of scope); worst was the bookingId collision (P-1), with the refund recovery/fallback bug (P-2) close behind.

Checks after the fixes: `pnpm lint`, `pnpm test:scripts` (35 pass), `pnpm test:live` (77 pass), `pnpm check:bundle` (build + leak check pass), `tsc --noEmit` clean. Nothing was broadcast to any network.
