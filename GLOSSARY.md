# FlyGate

FlyGate is an AI flight-booking agent whose spending is enforced on chain: an owner signs a mandate, and every payment the agent makes runs through the FlightEscrow contract on QoreChain diana.

## Demo modes

**Live mode** (proposed, live-checkout/D-24):
The demo setting in which chain steps are real QoreChain diana transactions with explorer-verifiable hashes.
_Avoid_: real mode, testnet mode

**Simulated mode** (proposed, live-checkout/D-24):
The demo setting in which chain steps are stand-ins with random hashes; signatures and encryption are still real.
_Avoid_: fake mode, mock mode

**Live read** (proposed, live-checkout/D-20):
A read-only chain query (such as an `eth_call`) shown as evidence without sending a transaction.
_Avoid_: dry run

## On-chain authority

**Mandate** (proposed, live-checkout/D-15):
The owner's signed spending rules for one agent; its registration in FlightEscrow is the **on-chain mandate**.
_Avoid_: authorization, policy

**Linked agent key** (proposed, live-checkout/D-09):
The agent's key, bound to the owner's account as an authenticator with spending rules, that authorizes bookings without being able to spend freely.
_Avoid_: session key, agent wallet

**Relayer** (proposed, live-checkout/D-09):
The account that broadcasts and pays fees for a transaction another key authorized.
_Avoid_: submitter, sponsor

**Scoped window** (proposed, live-checkout/D-12):
A bounded, time-limited permission opened by the owner that limits which contract EVM transactions may reach and how much they may spend.
_Avoid_: session, allowance
