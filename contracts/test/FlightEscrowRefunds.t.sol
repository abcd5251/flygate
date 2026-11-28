// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlightEscrow} from "../FlightEscrow.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/PqcMocks.sol";

/// Refund paths: merchant-signed cancel, expiry refund, ticket quota restore, single final state.
contract FlightEscrowRefundsTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint32 constant TICKET_WINDOW = 1 hours;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");
    address stranger = makeAddr("stranger");

    bytes merchantPubkey;
    uint256 constant BUDGET = 5 ether;
    FlightEscrow escrow;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(1_800_000_000);
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);

        merchantPubkey = _filled(2592, 0x11);
        MockPqcKeyStatus(PQC_KEY_STATUS).setStatus(merchant, true, 1, merchantPubkey, true);

        escrow = new FlightEscrow();
        vm.deal(owner, BUDGET);
        vm.prank(owner);
        escrow.openMandate{value: BUDGET}(agent, _mandate(2), BUDGET);
    }

    // ------------------------------------------------------------------ cancel

    function test_cancel_refundsOwnerAndEmitsCancelled() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        bytes memory sig = _signCancel(c);

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Refunded(bookingId, FlightEscrow.RefundReason.Cancelled);
        vm.prank(stranger);
        escrow.cancel(c, sig);

        assertEq(_budget(), BUDGET, "owner refunded to the budget");
        assertEq(stranger.balance, 0, "submitter gets nothing");
        assertEq(escrow.totalHeld(), BUDGET, "nothing paid out; all back in the budget");
    }

    // ------------------------------------------------------------------ expiry

    function test_refund_revertsAtDeadline() public {
        bytes32 bookingId = _book(1);
        vm.warp(block.timestamp + TICKET_WINDOW);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketDeadlineNotPassed.selector, bookingId));
        escrow.refund(bookingId);
        assertEq(_budget(), BUDGET - 1 ether, "funds stay locked");
    }

    function test_refund_oneSecondAfterDeadline_refundsOwnerAndEmitsExpired() public {
        bytes32 bookingId = _book(1);
        vm.warp(block.timestamp + TICKET_WINDOW + 1);

        vm.expectEmit(address(escrow));
        emit FlightEscrow.Refunded(bookingId, FlightEscrow.RefundReason.Expired);
        vm.prank(stranger);
        escrow.refund(bookingId);

        assertEq(_budget(), BUDGET, "owner refunded to the budget");
        assertEq(escrow.totalHeld(), BUDGET, "nothing paid out; all back in the budget");
    }

    function test_confirmTicket_revertsOneSecondAfterDeadline() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.TicketProof memory t = _ticketProof(bookingId);
        bytes memory sig = _signTicket(t);
        vm.warp(block.timestamp + TICKET_WINDOW + 1);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketDeadlinePassed.selector, bookingId));
        escrow.confirmTicket(t, sig);
    }

    function test_refund_calledByAgent_stillPaysOwner() public {
        bytes32 bookingId = _book(1);
        uint256 agentBefore = agent.balance;
        vm.warp(block.timestamp + TICKET_WINDOW + 1);

        vm.prank(agent);
        escrow.refund(bookingId);

        assertEq(_budget(), BUDGET, "owner refunded to the budget");
        assertEq(agent.balance, agentBefore, "agent gets nothing");
    }

    /// After the owner closed the mandate, a refund skips the budget and pays the owner directly.
    function test_cancel_afterCloseMandate_paysTheOwnerDirectly() public {
        bytes32 bookingId = _book(1);
        vm.prank(owner);
        escrow.closeMandate(agent);
        assertEq(owner.balance, BUDGET - 1 ether, "close returned the unspent budget");

        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        escrow.cancel(c, _signCancel(c));
        assertEq(owner.balance, BUDGET, "the cancelled booking came back too");
        assertEq(address(escrow).balance, 0, "escrow holds nothing");
        assertEq(escrow.totalHeld(), 0);
    }

    function test_refund_revertsForUnknownBooking() public {
        bytes32 unknown = keccak256("nope");
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, unknown));
        escrow.refund(unknown);
    }

    // ------------------------------------------------------------------- quota

    function test_book_revertsWhenTicketQuotaUsedUp() public {
        _book(1);
        _book(2);
        FlightEscrow.Quote memory q = _quote(3);
        bytes memory sig = _allow(keccak256("QUOTE"), abi.encode(q), 0xA1);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketQuotaExhausted.selector, 2));
        vm.prank(agent);
        escrow.book(q, sig);
    }

    function test_book_ticketedBookingsCountAgainstQuota() public {
        bytes32 first = _book(1);
        FlightEscrow.TicketProof memory t = _ticketProof(first);
        escrow.confirmTicket(t, _signTicket(t));
        _book(2);
        FlightEscrow.Quote memory q = _quote(3);
        bytes memory sig = _allow(keccak256("QUOTE"), abi.encode(q), 0xA1);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketQuotaExhausted.selector, 2));
        vm.prank(agent);
        escrow.book(q, sig);
    }

    function test_book_quotaStaysExhaustedAfterOwnerResetsTheMandate() public {
        _book(1);
        _book(2);
        vm.prank(owner);
        escrow.openMandate(agent, _mandate(2), 0); // same quota, fresh terms: the used count stays 2
        FlightEscrow.Quote memory q = _quote(3);
        bytes memory sig = _allow(keccak256("QUOTE"), abi.encode(q), 0xA1);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.TicketQuotaExhausted.selector, 2));
        vm.prank(agent);
        escrow.book(q, sig);
    }

    function test_book_worksAgainAfterCancelRestoresQuota() public {
        bytes32 first = _book(1);
        _book(2);
        FlightEscrow.CancelProof memory c = _cancelProof(first);
        escrow.cancel(c, _signCancel(c));

        _book(3);
        assertEq(_budget(), BUDGET - 2 ether, "two bookings locked");
    }

    function test_book_worksAgainAfterExpiryRefundRestoresQuota() public {
        bytes32 first = _book(1);
        _book(2);
        vm.warp(block.timestamp + TICKET_WINDOW + 1);
        escrow.refund(first);

        _book(3);
        assertEq(_budget(), BUDGET - 2 ether, "two bookings locked");
    }

    // ------------------------------------------------------ single final state

    function test_refundAndCancel_revertAfterRelease() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.TicketProof memory t = _ticketProof(bookingId);
        escrow.confirmTicket(t, _signTicket(t));
        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        bytes memory cancelSig = _signCancel(c);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.cancel(c, cancelSig);

        vm.warp(block.timestamp + TICKET_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.refund(bookingId);
        assertEq(_budget(), BUDGET - 1 ether, "owner not refunded");
    }

    function test_confirmTicketAndCancel_revertAfterCancel() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        bytes memory cancelSig = _signCancel(c);
        escrow.cancel(c, cancelSig);
        FlightEscrow.TicketProof memory t = _ticketProof(bookingId);
        bytes memory ticketSig = _signTicket(t);
        uint256 merchantBefore = merchant.balance;

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.confirmTicket(t, ticketSig);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.cancel(c, cancelSig);
        assertEq(merchant.balance, merchantBefore, "merchant not paid");
        assertEq(_budget(), BUDGET, "owner refunded once");
    }

    function test_confirmTicketAndRefund_revertAfterExpiryRefund() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.TicketProof memory t = _ticketProof(bookingId);
        bytes memory ticketSig = _signTicket(t);
        vm.warp(block.timestamp + TICKET_WINDOW + 1);
        escrow.refund(bookingId);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.confirmTicket(t, ticketSig);

        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.NotLocked.selector, bookingId));
        escrow.refund(bookingId);
        assertEq(_budget(), BUDGET, "owner refunded once");
    }

    // ------------------------------------------------------------ type tags

    /// Same struct bytes, signed under the other proof's TYPE_TAG: the tag alone must make it fail.
    function test_cancel_revertsOnTicketProofSignature() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        bytes memory ticketTaggedSig = _allow(keccak256("TICKET"), abi.encode(c), 0xB1);

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        escrow.cancel(c, ticketTaggedSig);
        assertEq(_budget(), BUDGET - 1 ether, "funds stay locked");
    }

    function test_confirmTicket_revertsOnCancelProofSignature() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.TicketProof memory t = _ticketProof(bookingId);
        bytes memory cancelTaggedSig = _allow(keccak256("CANCEL"), abi.encode(t), 0xC1);

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        escrow.confirmTicket(t, cancelTaggedSig);
        assertEq(_budget(), BUDGET - 1 ether, "funds stay locked");
    }

    function test_cancel_revertsOnWrongSignature() public {
        bytes32 bookingId = _book(1);
        FlightEscrow.CancelProof memory c = _cancelProof(bookingId);
        _signCancel(c);

        vm.expectRevert(FlightEscrow.InvalidSignature.selector);
        escrow.cancel(c, _filled(4627, 0xEE));
    }

    // ----------------------------------------------------------------- helpers

    function _budget() internal view returns (uint256) {
        return escrow.mandateOf(owner, agent).budget;
    }

    function _book(uint256 offerSeed) internal returns (bytes32 bookingId) {
        FlightEscrow.Quote memory q = _quote(offerSeed);
        bytes memory sig = _allow(keccak256("QUOTE"), abi.encode(q), 0xA1);
        vm.prank(agent);
        bookingId = escrow.book(q, sig);
    }

    function _mandate(uint32 maxTickets) internal view returns (FlightEscrow.Mandate memory) {
        return FlightEscrow.Mandate({
            merchant: merchant,
            maxFareWei: 500 ether,
            maxTickets: maxTickets,
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

    function _quote(uint256 offerSeed) internal view returns (FlightEscrow.Quote memory) {
        return FlightEscrow.Quote({
            merchant: merchant,
            agent: agent,
            owner: owner,
            offerId: keccak256(abi.encode("offer", offerSeed)),
            priceWei: 1 ether,
            origin: "TPE",
            destination: "TYO",
            departDay: uint32(block.timestamp / 1 days + 10),
            cabin: FlightEscrow.Cabin.Economy,
            refundable: true,
            expiresAt: uint64(block.timestamp + 15 minutes),
            ticketWindow: TICKET_WINDOW
        });
    }

    function _ticketProof(bytes32 bookingId) internal view returns (FlightEscrow.TicketProof memory) {
        return FlightEscrow.TicketProof({
            bookingId: bookingId,
            pnrHash: keccak256(abi.encodePacked("ABC123", bytes32("passenger-salt"))),
            issuedAt: uint64(block.timestamp)
        });
    }

    function _cancelProof(bytes32 bookingId) internal pure returns (FlightEscrow.CancelProof memory) {
        return FlightEscrow.CancelProof({bookingId: bookingId, reasonCode: 3});
    }

    function _signTicket(FlightEscrow.TicketProof memory t) internal returns (bytes memory) {
        return _allow(keccak256("TICKET"), abi.encode(t), 0xB1);
    }

    function _signCancel(FlightEscrow.CancelProof memory c) internal returns (bytes memory) {
        return _allow(keccak256("CANCEL"), abi.encode(c), 0xC1);
    }

    /// QoreSign prefix + lowercase hex of the typed digest, built independently of the contract.
    function _message(bytes32 typeTag, bytes memory encodedStruct) internal view returns (bytes memory) {
        bytes32 digest = keccak256(bytes.concat(abi.encode(typeTag, block.chainid, address(escrow)), encodedStruct));
        return bytes(string.concat("qorechain-msg-v1|qorechain-diana|", vm.toString(digest)));
    }

    function _allow(bytes32 typeTag, bytes memory encodedStruct, uint8 sigSeed) internal returns (bytes memory sig) {
        sig = _filled(4627, sigSeed);
        MockPqcVerify(PQC_VERIFY).allow(merchantPubkey, sig, _message(typeTag, encodedStruct));
    }

    function _filled(uint256 len, uint8 b) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = bytes1(b);
        }
    }
}
