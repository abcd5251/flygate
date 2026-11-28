// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlightEscrow} from "../../FlightEscrow.sol";
import {MockPqcKeyStatus} from "../mocks/PqcMocks.sol";
import {FfiPqcVerify} from "../mocks/FfiPqcVerify.sol";

/// @notice Cross-checks src/lib/escrow.ts against the contract: TS builds the message and signs
///         it with real ML-DSA-87 from a fixed seed, and the 0x...0A01 mock verifies it for real.
///         If book / confirmTicket accept the signature, Solidity and TS sign the same bytes.
///         Part of plain `forge test` (ffi on); needs `pnpm install` for tsx and noble.
contract FlightEscrowFfiTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    /// @dev Fixed ML-DSA-87 merchant seed so keys and signatures are reproducible in CI.
    bytes32 constant MERCHANT_SEED = keccak256("flygate-ffi-test-merchant");

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");

    FlightEscrow escrow;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(1_800_000_000);
        vm.etch(PQC_VERIFY, type(FfiPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);

        string[] memory args = new string[](2);
        args[0] = "pubkey";
        args[1] = vm.toString(MERCHANT_SEED);
        bytes memory pubkey = _ffi(args);
        assertEq(pubkey.length, 2592, "ML-DSA-87 pubkey length");
        MockPqcKeyStatus(PQC_KEY_STATUS).setStatus(merchant, true, 1, pubkey, true);

        escrow = new FlightEscrow();
        vm.deal(owner, 10 ether);

        vm.prank(owner);
        escrow.openMandate{value: 10 ether}(
            agent,
            FlightEscrow.Mandate({
                merchant: merchant,
                maxFareWei: 2 ether,
                maxTickets: 2,
                expiresAt: uint64(block.timestamp + 7 days),
                origin: "TPE",
                destination: "TYO",
                departFrom: uint32(block.timestamp / 1 days),
                departTo: uint32(block.timestamp / 1 days + 30),
                cabin: FlightEscrow.Cabin.Business,
                refundableOnly: false,
                mandateHash: keccak256("mandate")
            }),
            10 ether
        );
    }

    function test_ffi_bookAcceptsRealTsSignature() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory sig = _signQuote(q);
        assertEq(sig.length, 4627, "ML-DSA-87 signature length");

        vm.prank(agent);
        escrow.book(q, sig);

        assertEq(escrow.mandateOf(owner, agent).budget, 10 ether - q.priceWei, "price locked from the budget");
    }

    function test_ffi_bookRevertsWhenOneSignatureByteIsFlipped() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory sig = _signQuote(q);
        sig[100] = sig[100] ^ 0x01;

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        vm.prank(agent);
        escrow.book(q, sig);
    }

    /// A valid ML-DSA-87 signature over the right bytes, but from a key other than the
    /// merchant's registered one.
    function test_ffi_bookRevertsWhenSignedByADifferentKey() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory sig = _signQuoteWith(keccak256("flygate-ffi-test-impostor"), q);
        assertEq(sig.length, 4627, "a real ML-DSA-87 signature");

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        vm.prank(agent);
        escrow.book(q, sig);
    }

    function test_ffi_confirmTicketAcceptsRealTsTicketProof() public {
        FlightEscrow.Quote memory q = _quote();
        vm.prank(agent);
        bytes32 bookingId = escrow.book(q, _signQuote(q));

        FlightEscrow.TicketProof memory t = FlightEscrow.TicketProof({
            bookingId: bookingId,
            pnrHash: keccak256(abi.encodePacked("ABC123", bytes32("salt"))),
            issuedAt: uint64(block.timestamp + 60)
        });
        bytes memory sig = _signTicket(t);
        uint256 merchantBefore = merchant.balance;

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Released(bookingId, t.pnrHash);
        escrow.confirmTicket(t, sig);

        assertEq(merchant.balance - merchantBefore, q.priceWei, "merchant paid");
    }

    function test_ffi_confirmTicketRejectsQuoteSignatureReusedAsTicketProof() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory quoteSig = _signQuote(q);
        vm.prank(agent);
        bytes32 bookingId = escrow.book(q, quoteSig);

        FlightEscrow.TicketProof memory t =
            FlightEscrow.TicketProof({bookingId: bookingId, pnrHash: keccak256("pnr"), issuedAt: 1});

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        escrow.confirmTicket(t, quoteSig);
    }

    function test_ffi_cancelAcceptsRealTsCancelProof() public {
        FlightEscrow.Quote memory q = _quote();
        vm.prank(agent);
        bytes32 bookingId = escrow.book(q, _signQuote(q));

        FlightEscrow.CancelProof memory c = FlightEscrow.CancelProof({bookingId: bookingId, reasonCode: 3});
        bytes memory sig = _signCancel(c);

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Refunded(bookingId, FlightEscrow.RefundReason.Cancelled);
        escrow.cancel(c, sig);

        assertEq(escrow.mandateOf(owner, agent).budget, 10 ether, "owner refunded to the budget");
    }

    // ------------------------------------------------------------------ helpers

    function _quote() internal view returns (FlightEscrow.Quote memory) {
        return FlightEscrow.Quote({
            merchant: merchant,
            agent: agent,
            owner: owner,
            offerId: keccak256("off_0001"),
            priceWei: 1 ether,
            origin: "TPE",
            destination: "TYO",
            departDay: uint32(block.timestamp / 1 days + 10),
            cabin: FlightEscrow.Cabin.Business,
            refundable: true,
            expiresAt: uint64(block.timestamp + 15 minutes),
            ticketWindow: 600
        });
    }

    function _signQuote(FlightEscrow.Quote memory q) internal returns (bytes memory) {
        return _signQuoteWith(MERCHANT_SEED, q);
    }

    function _signQuoteWith(bytes32 seed, FlightEscrow.Quote memory q) internal returns (bytes memory) {
        string[] memory args = new string[](16);
        args[0] = "sign-quote";
        args[1] = vm.toString(seed);
        args[2] = vm.toString(block.chainid);
        args[3] = vm.toString(address(escrow));
        args[4] = vm.toString(q.merchant);
        args[5] = vm.toString(q.agent);
        args[6] = vm.toString(q.owner);
        args[7] = vm.toString(q.offerId);
        args[8] = vm.toString(q.priceWei);
        args[9] = string(abi.encodePacked(q.origin));
        args[10] = string(abi.encodePacked(q.destination));
        args[11] = vm.toString(uint256(q.departDay));
        args[12] = vm.toString(uint256(q.cabin));
        args[13] = vm.toString(q.refundable);
        args[14] = vm.toString(uint256(q.expiresAt));
        args[15] = vm.toString(uint256(q.ticketWindow));
        return _ffi(args);
    }

    function _signTicket(FlightEscrow.TicketProof memory t) internal returns (bytes memory) {
        string[] memory args = new string[](7);
        args[0] = "sign-ticket";
        args[1] = vm.toString(MERCHANT_SEED);
        args[2] = vm.toString(block.chainid);
        args[3] = vm.toString(address(escrow));
        args[4] = vm.toString(t.bookingId);
        args[5] = vm.toString(t.pnrHash);
        args[6] = vm.toString(uint256(t.issuedAt));
        return _ffi(args);
    }

    function _signCancel(FlightEscrow.CancelProof memory c) internal returns (bytes memory) {
        string[] memory args = new string[](6);
        args[0] = "sign-cancel";
        args[1] = vm.toString(MERCHANT_SEED);
        args[2] = vm.toString(block.chainid);
        args[3] = vm.toString(address(escrow));
        args[4] = vm.toString(c.bookingId);
        args[5] = vm.toString(uint256(c.reasonCode));
        return _ffi(args);
    }

    /// @dev Runs `tsx scripts/escrow-ffi.ts <args>`; the script prints 0x-hex, which forge decodes to bytes.
    function _ffi(string[] memory args) internal returns (bytes memory) {
        string[] memory cmd = new string[](args.length + 2);
        cmd[0] = "node_modules/.bin/tsx";
        cmd[1] = "scripts/escrow-ffi.ts";
        for (uint256 i; i < args.length; ++i) {
            cmd[i + 2] = args[i];
        }
        return vm.ffi(cmd);
    }
}
