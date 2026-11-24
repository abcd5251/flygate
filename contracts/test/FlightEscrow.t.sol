// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlightEscrow} from "../FlightEscrow.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/PqcMocks.sol";

contract FlightEscrowTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");

    bytes merchantPubkey;
    FlightEscrow escrow;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(1_800_000_000);
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);

        merchantPubkey = _filled(2592, 0x11);
        _setMerchantKey(true, 1, true);

        escrow = new FlightEscrow();
        vm.deal(agent, 10 ether);
    }

    // ---------------------------------------------------------------- deploy

    function test_deploy_revertsOffDiana() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.WrongChain.selector, 1));
        new FlightEscrow();
    }

    // ------------------------------------------------------------ happy path

    function test_happyPath_paysMerchantAndEmitsBookedAndReleased() public {
        FlightEscrow.Quote memory q = _quote();
        bytes32 bookingId = keccak256(abi.encode(q));
        _setMandate();
        bytes memory quoteSig = _signQuote(q);

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Booked(bookingId, agent, merchant, q.priceWei, uint64(block.timestamp + q.ticketWindow));
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, quoteSig);

        assertEq(address(escrow).balance, q.priceWei, "funds locked in escrow");
        assertEq(agent.balance, 10 ether - q.priceWei, "agent paid");

        FlightEscrow.TicketProof memory t = _ticket(bookingId);
        bytes memory ticketSig = _signTicket(t);
        uint256 merchantBefore = merchant.balance;

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Released(bookingId, t.pnrHash);
        vm.prank(merchant);
        escrow.confirmTicket(t, ticketSig);

        assertEq(merchant.balance - merchantBefore, q.priceWei, "merchant paid priceWei");
        assertEq(address(escrow).balance, 0, "escrow emptied");
    }

    // ------------------------------------------------------------ signatures

    function test_book_revertsOnWrongSignature() public {
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        _signQuote(q);
        bytes memory forged = _filled(4627, 0xEE);

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, forged);
        assertEq(agent.balance, 10 ether, "agent keeps funds");
    }

    function test_book_revertsWhenSignedQuoteDiffersFromSubmitted() public {
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);
        q.priceWei = 0.5 ether; // agent tampers with the price after the merchant signed

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, sig);
    }

    function test_confirmTicket_revertsOnWrongSignature() public {
        bytes32 bookingId = _book();
        FlightEscrow.TicketProof memory t = _ticket(bookingId);
        _signTicket(t);
        bytes memory forged = _filled(4627, 0xEE);
        uint256 merchantBefore = merchant.balance;

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        escrow.confirmTicket(t, forged);
        assertEq(merchant.balance, merchantBefore, "merchant not paid");
    }

    // ----------------------------------------------------------- merchant key

    function test_book_revertsWhenMerchantKeyLacksPossessionProof() public {
        _setMerchantKey(true, 1, false);
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.MerchantKeyPossessionUnproven.selector, merchant));
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, sig);
    }

    function test_book_revertsWhenMerchantKeyNotRegistered() public {
        _setMerchantKey(false, 0, false);
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.MerchantKeyNotRegistered.selector, merchant));
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, sig);
    }

    function test_book_revertsWhenMerchantKeyIsNotMlDsa87() public {
        _setMerchantKey(true, 2, true);
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.UnsupportedKeyAlgorithm.selector, 2));
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, sig);
    }

    // ----------------------------------------------------------- ticket window

    function test_confirmTicket_succeedsAtDeadline() public {
        bytes32 bookingId = _book();
        FlightEscrow.TicketProof memory t = _ticket(bookingId);
        bytes memory sig = _signTicket(t);
        uint256 merchantBefore = merchant.balance;

        vm.warp(block.timestamp + _quote().ticketWindow);
        escrow.confirmTicket(t, sig);
        assertEq(merchant.balance - merchantBefore, 1 ether, "merchant paid at deadline");
    }

    function test_confirmTicket_revertsOneSecondAfterDeadline() public {
        bytes32 bookingId = _book();
        FlightEscrow.TicketProof memory t = _ticket(bookingId);
        bytes memory sig = _signTicket(t);

        vm.warp(block.timestamp + _quote().ticketWindow + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketDeadlinePassed.selector, bookingId));
        escrow.confirmTicket(t, sig);
        assertEq(address(escrow).balance, 1 ether, "funds stay locked");
    }

    // ------------------------------------------------------------- payment

    function test_book_revertsWhenValueDiffersFromPrice() public {
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.WrongPayment.selector, q.priceWei, q.priceWei - 1));
        vm.prank(agent);
        escrow.book{value: q.priceWei - 1}(q, sig);
    }

    function test_confirmTicket_revertsTheSecondTime() public {
        bytes32 bookingId = _book();
        FlightEscrow.TicketProof memory t = _ticket(bookingId);
        bytes memory sig = _signTicket(t);
        escrow.confirmTicket(t, sig);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.confirmTicket(t, sig);
    }

    // --------------------------------------------------------------- helpers

    function _book() internal returns (bytes32 bookingId) {
        FlightEscrow.Quote memory q = _quote();
        _setMandate();
        bytes memory sig = _signQuote(q);
        vm.prank(agent);
        bookingId = escrow.book{value: q.priceWei}(q, sig);
    }

    function _mandate() internal view returns (FlightEscrow.Mandate memory) {
        return FlightEscrow.Mandate({
            merchant: merchant,
            maxFareWei: 500 ether,
            maxTickets: 2,
            expiresAt: uint64(block.timestamp + 7 days),
            origin: "TPE",
            destination: "TYO",
            departFrom: uint32(block.timestamp / 1 days),
            departTo: uint32(block.timestamp / 1 days + 30),
            cabin: FlightEscrow.Cabin.Economy,
            refundableOnly: false,
            mandateHash: keccak256("owner-approved mandate text")
        });
    }

    function _quote() internal view returns (FlightEscrow.Quote memory) {
        return FlightEscrow.Quote({
            merchant: merchant,
            agent: agent,
            offerId: keccak256("offer-1"),
            priceWei: 1 ether,
            origin: "TPE",
            destination: "TYO",
            departDay: uint32(block.timestamp / 1 days + 10),
            cabin: FlightEscrow.Cabin.Economy,
            refundable: true,
            expiresAt: uint64(block.timestamp + 15 minutes),
            ticketWindow: 1 hours
        });
    }

    function _ticket(bytes32 bookingId) internal view returns (FlightEscrow.TicketProof memory) {
        return FlightEscrow.TicketProof({
            bookingId: bookingId,
            pnrHash: keccak256(abi.encodePacked("ABC123", bytes32("passenger-salt"))),
            issuedAt: uint64(block.timestamp)
        });
    }

    function _setMandate() internal {
        vm.prank(owner);
        escrow.setMandate(agent, _mandate());
    }

    function _setMerchantKey(bool registered, uint8 algorithmId, bool possessionProven) internal {
        MockPqcKeyStatus(PQC_KEY_STATUS).setStatus(merchant, registered, algorithmId, merchantPubkey, possessionProven);
    }

    /// Message the merchant's wallet signs: QoreSign prefix + lowercase hex of the typed digest.
    /// Built with vm.toString so it is independent of the contract's own hex encoder.
    function _message(bytes32 typeTag, bytes memory encodedStruct) internal view returns (bytes memory) {
        bytes32 digest = keccak256(bytes.concat(abi.encode(typeTag, block.chainid, address(escrow)), encodedStruct));
        return bytes(string.concat("qorechain-msg-v1|qorechain-diana|", vm.toString(digest)));
    }

    function _allow(bytes32 typeTag, bytes memory encodedStruct, uint8 sigSeed) internal returns (bytes memory sig) {
        sig = _filled(4627, sigSeed);
        MockPqcVerify(PQC_VERIFY).allow(merchantPubkey, sig, _message(typeTag, encodedStruct));
    }

    function _signQuote(FlightEscrow.Quote memory q) internal returns (bytes memory) {
        return _allow(keccak256("QUOTE"), abi.encode(q), 0xA1);
    }

    function _signTicket(FlightEscrow.TicketProof memory t) internal returns (bytes memory) {
        return _allow(keccak256("TICKET"), abi.encode(t), 0xB1);
    }

    function _filled(uint256 len, uint8 b) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = bytes1(b);
        }
    }
}
