---
status: superseded
---

# The agent books from the owner's account; refunds return to the owner's EVM signer

Status: Superseded by ADR-0003 (the owner signs with their own QoreX wallet; FlyGate never holds an owner key)

The agent's coin-60 key is linked to the owner's canonical qor1 account as an authenticator (`linkAuthenticatorMsgs`, `allowedEvmCalls` limited to `FlightEscrow.book`). `book()` runs through `MsgExecuteEVM`, relayed by the agent's qor1 account, so `msg.sender` is the owner account's 0x address and the fare leaves the owner's wallet. FlightEscrow refunds whoever called `setMandate`. The owner account's 0x address has no EVM key (ticket #13), so the owner's coin-60 EVM signer sends `setMandate` with `agent = owner account 0x`, and refunds land on that EVM signer, not on the paying address. The considered alternatives were worse. Linking an owner key too would let the agent call `setMandate`, because spending rules are account-wide. Changing the contract to refund the payer belongs to #7. Booking from the agent's own EOA does not use `MsgExecuteEVM` as requested and pays from the agent's funds, so it stays the fallback lane if the diana probe (`pnpm live:probe`) disproves these assumptions.
