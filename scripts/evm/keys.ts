// EVM keys and addresses for the bootstrap roles (one mnemonic per role).
//
// Measured on diana (2026-11-24): a role's bootstrap account (coin 118, qor1...) is
// visible on the EVM side at the hex of its 20 address bytes. That address holds the
// role's balance and its registered ML-DSA-87 key (pqcKeyStatus answers for it), but
// no EVM private key controls it: an EVM tx sender is keccak(pubkey), never
// ripemd160(sha256(pubkey)). So each role has two EVM addresses:
//   account  the bootstrap account. Use it as the merchant address in mandates and
//            quotes (pqcKeyStatus lookup, payout).
//   signer   the coin-60 key from the same mnemonic (what MetaMask and
//            `cast wallet --mnemonic` derive). Use it to send EVM txs (deploy,
//            setMandate, book); msg.sender is this address. A separate account that
//            must be funded on its own.
import { deriveEvmAccount, deriveNativeAccount, qoreAddresses } from "@qorechain/sdk";
import { bytesToHex, type Hex } from "viem";
import type { Role } from "../bootstrap/env";

export interface EvmRole {
  role: Role;
  /** The bootstrap account: holds the PQC key and the bank balance. */
  account: { cosmos: string; evm: Hex };
  /** The EVM-signing key (coin 60). `privateKey` is a secret: never log it. */
  signer: { cosmos: string; address: Hex; privateKey: Hex };
}

export async function deriveEvmRole(role: Role, mnemonic: string): Promise<EvmRole> {
  const native = await deriveNativeAccount(mnemonic);
  const evm = await deriveEvmAccount(mnemonic);
  return {
    role,
    account: { cosmos: native.address, evm: qoreAddresses({ cosmos: native.address }).evm as Hex },
    signer: {
      cosmos: qoreAddresses({ evm: evm.address }).cosmos,
      address: evm.address as Hex,
      privateKey: bytesToHex(evm.privateKey),
    },
  };
}
