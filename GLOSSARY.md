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

**Budget** (ADR-0003):
The QOR the owner deposits into FlightEscrow with a mandate; the agent can only lock it into bookings that pass the mandate, and the owner withdraws what is unspent.
_Avoid_: allowance, balance

**Session key** (ADR-0003):
A random key the owner's browser makes when it signs a mandate; its hash is part of the on-chain mandateHash, and FlyGate's server makes the agent act for an owner only with it.
_Avoid_: login token, API key

**Linked agent key** (superseded by ADR-0003):
The agent's key bound to the owner's account as an authenticator; QoreX does not let a website set this up, so Live no longer uses it.
_Avoid_: session key, agent wallet

**Relayer** (proposed, live-checkout/D-09):
The account that broadcasts and pays fees for a transaction another key authorized. In Live, FlyGate's agent pays the fees of every agent and merchant step.
_Avoid_: submitter, sponsor

**Scoped window** (proposed, live-checkout/D-12):
A bounded, time-limited permission that limits which contract an account's EVM transactions may reach and how much they may spend. Only FlyGate's own signers open one now; an owner's QoreX wallet never needs one (ADR-0003).
_Avoid_: session, allowance
