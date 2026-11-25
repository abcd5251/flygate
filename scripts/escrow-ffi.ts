/**
 * Foundry vm.ffi bridge to src/lib/escrow.ts (contracts/test/ffi). Prints one 0x-hex value,
 * which forge decodes to bytes. Struct fields arrive as separate args so the encoding is done
 * here, independently of Solidity.
 *
 *   pubkey      <seed>
 *   sign-quote  <seed> <chainId> <escrow> <merchant> <agent> <owner> <offerId> <priceWei> <origin>
 *               <destination> <departDay> <cabin> <refundable> <expiresAt> <ticketWindow>
 *   sign-ticket <seed> <chainId> <escrow> <bookingId> <pnrHash> <issuedAt>
 *   sign-cancel <seed> <chainId> <escrow> <bookingId> <reasonCode>
 *   verify      <pubkey> <signature> <message>   -> abi.encode(bool)
 */
import { bytesToHex, encodeAbiParameters, getAddress, hexToBytes, type Hex } from "viem";
import {
  merchantKeys,
  signCancelProof,
  signQuote,
  signTicketProof,
  verifyMessage,
  type Cabin,
  type Domain,
} from "../src/lib/escrow";

const [command, ...args] = process.argv.slice(2);

function domain(chainId: string, escrow: string): Domain {
  return { chainId: BigInt(chainId), escrow: getAddress(escrow) };
}

function run(): Hex {
  switch (command) {
    case "pubkey":
      return bytesToHex(merchantKeys(args[0] as Hex).publicKey);
    case "sign-quote": {
      const [seed, chainId, escrow, merchant, agent, owner, offerId, priceWei, origin, destination, ...rest] =
        args;
      const [departDay, cabin, refundable, expiresAt, ticketWindow] = rest;
      const quote = {
        merchant: getAddress(merchant),
        agent: getAddress(agent),
        owner: getAddress(owner),
        offerId: offerId as Hex,
        priceWei: BigInt(priceWei),
        origin,
        destination,
        departDay: Number(departDay),
        cabin: Number(cabin) as Cabin,
        refundable: refundable === "true",
        expiresAt: BigInt(expiresAt),
        ticketWindow: Number(ticketWindow),
      };
      return signQuote(quote, domain(chainId, escrow), merchantKeys(seed as Hex));
    }
    case "sign-ticket": {
      const [seed, chainId, escrow, bookingId, pnrHash, issuedAt] = args;
      const proof = { bookingId: bookingId as Hex, pnrHash: pnrHash as Hex, issuedAt: BigInt(issuedAt) };
      return signTicketProof(proof, domain(chainId, escrow), merchantKeys(seed as Hex));
    }
    case "sign-cancel": {
      const [seed, chainId, escrow, bookingId, reasonCode] = args;
      const proof = { bookingId: bookingId as Hex, reasonCode: Number(reasonCode) };
      return signCancelProof(proof, domain(chainId, escrow), merchantKeys(seed as Hex));
    }
    case "verify": {
      const [pubkey, signature, message] = args as Hex[];
      const ok = verifyMessage(pubkey, signature, hexToBytes(message));
      return encodeAbiParameters([{ type: "bool" }], [ok]);
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

process.stdout.write(run());
