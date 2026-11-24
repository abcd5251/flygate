// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlightEscrow} from "../FlightEscrow.sol";
import {MockPqcVerify, MockPqcKeyStatus} from "./mocks/PqcMocks.sol";

/// @notice book() enforces the owner's mandate; revokeMandate stops new bookings.
contract FlightEscrowBookRulesTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEY_STATUS = 0x0000000000000000000000000000000000000a02;
    uint256 constant T0 = 1_800_000_000;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");

    bytes merchantPubkey;
    FlightEscrow escrow;

    function setUp() public {
        vm.chainId(9800);
        vm.warp(T0);
        vm.etch(PQC_VERIFY, type(MockPqcVerify).runtimeCode);
        vm.etch(PQC_KEY_STATUS, type(MockPqcKeyStatus).runtimeCode);

        merchantPubkey = _filled(2592, 0x11);
        MockPqcKeyStatus(PQC_KEY_STATUS).setStatus(merchant, true, 1, merchantPubkey, true);

        escrow = new FlightEscrow();
        vm.deal(agent, 10 ether);
        _setMandate(_mandate());
    }

    // ----------------------------------------------------------------- revoke

    function test_revokeMandate_blocksNewBookingsAndEmits() public {
        vm.expectEmit(address(escrow));
        emit FlightEscrow.MandateRevoked(owner, agent);
        vm.prank(owner);
        escrow.revokeMandate(agent);

        _expectBookRevert(_quote(), abi.encodeWithSelector(FlightEscrow.MandateIsRevoked.selector));
    }

    function test_revokeMandate_byAnyoneElse_leavesTheOwnersMandateActive() public {
        vm.expectRevert(FlightEscrow.NoMandate.selector);
        vm.prank(agent);
        escrow.revokeMandate(agent);

        _bookOk(_quote()); // owner's mandate still active
    }

    // ------------------------------------------------------------- front-run

    /// Anyone can call setMandate for any agent, but it only writes the caller's own
    /// (owner, agent) slot: the real owner's rules, quota and refunds are untouched.
    function test_setMandate_byAttackerForSameAgent_cannotTouchOwnersMandateOrRefunds() public {
        address attacker = makeAddr("attacker");
        FlightEscrow.Mandate memory evil = _mandate();
        evil.maxTickets = 0;
        evil.cabin = FlightEscrow.Cabin.First;
        vm.prank(attacker);
        escrow.setMandate(agent, evil);
        vm.prank(attacker);
        escrow.revokeMandate(agent);

        bytes32 bookingId = _bookOk(_quote()); // still booked under the owner's mandate

        FlightEscrow.CancelProof memory c = FlightEscrow.CancelProof({bookingId: bookingId, reasonCode: 1});
        escrow.cancel(c, _allow(keccak256("CANCEL"), abi.encode(c), 0xC1));
        assertEq(owner.balance, 1 ether, "refund went to the real owner");
        assertEq(attacker.balance, 0, "attacker got nothing");
    }

    function test_book_revertsWhenQuoteNamesAnOwnerWithoutAMandate() public {
        FlightEscrow.Quote memory q = _quote();
        q.owner = makeAddr("attacker");
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.NoMandate.selector));
    }

    /// Intended: a revoke is undone only by the owner signing a new mandate.
    function test_setMandate_reEnablesARevokedAgent() public {
        vm.prank(owner);
        escrow.revokeMandate(agent);
        _expectBookRevert(_quote(), abi.encodeWithSelector(FlightEscrow.MandateIsRevoked.selector));

        _setMandate(_mandate());
        _bookOk(_quote());
    }

    function test_revokeMandate_lockedBookingCanStillBeTicketed() public {
        bytes32 bookingId = _bookOk(_quote());
        vm.prank(owner);
        escrow.revokeMandate(agent);

        FlightEscrow.TicketProof memory t = FlightEscrow.TicketProof({
            bookingId: bookingId, pnrHash: keccak256("pnr"), issuedAt: uint64(block.timestamp)
        });
        bytes memory sig = _allow(keccak256("TICKET"), abi.encode(t), 0xB1);
        uint256 merchantBefore = merchant.balance;

        escrow.confirmTicket(t, sig);
        assertEq(merchant.balance - merchantBefore, 1 ether, "merchant paid after revoke");
    }

    // ------------------------------------------------------------- mandate rules

    function test_book_revertsWhenFareOverCap() public {
        FlightEscrow.Mandate memory m = _mandate();
        m.maxFareWei = 1 ether - 1;
        _setMandate(m);
        _expectBookRevert(_quote(), abi.encodeWithSelector(FlightEscrow.FareOverCap.selector, 1 ether - 1, 1 ether));
    }

    function test_book_acceptsFareEqualToCap() public {
        FlightEscrow.Mandate memory m = _mandate();
        m.maxFareWei = 1 ether;
        _setMandate(m);
        _bookOk(_quote());
    }

    function test_book_revertsWhenOriginMismatches() public {
        FlightEscrow.Quote memory q = _quote();
        q.origin = "KHH";
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.RouteMismatch.selector));
    }

    function test_book_revertsWhenDestinationMismatches() public {
        FlightEscrow.Quote memory q = _quote();
        q.destination = "OSA";
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.RouteMismatch.selector));
    }

    function test_book_revertsWhenDepartDayBeforeRange() public {
        FlightEscrow.Quote memory q = _quote();
        q.departDay = _mandate().departFrom - 1;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.DepartDayOutOfRange.selector, q.departDay));
    }

    function test_book_revertsWhenDepartDayAfterRange() public {
        FlightEscrow.Quote memory q = _quote();
        q.departDay = _mandate().departTo + 1;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.DepartDayOutOfRange.selector, q.departDay));
    }

    function test_book_acceptsDepartDayOnRangeEdges() public {
        FlightEscrow.Quote memory q = _quote();
        q.departDay = _mandate().departFrom;
        _bookOk(q);
        q.departDay = _mandate().departTo;
        _bookOk(q);
    }

    function test_book_revertsWhenCabinMismatches() public {
        FlightEscrow.Quote memory q = _quote();
        q.cabin = FlightEscrow.Cabin.Business;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.CabinMismatch.selector));
    }

    function test_book_revertsWhenRefundableRequiredButQuoteIsNot() public {
        FlightEscrow.Mandate memory m = _mandate();
        m.refundableOnly = true;
        _setMandate(m);
        FlightEscrow.Quote memory q = _quote();
        q.refundable = false;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.RefundableRequired.selector));
    }

    function test_book_acceptsNonRefundableWhenNotRequired() public {
        FlightEscrow.Quote memory q = _quote();
        q.refundable = false;
        _bookOk(q);
    }

    function test_book_revertsWhenMerchantIsNotTheMandatesMerchant() public {
        address other = makeAddr("otherMerchant");
        MockPqcKeyStatus(PQC_KEY_STATUS).setStatus(other, true, 1, merchantPubkey, true);
        FlightEscrow.Quote memory q = _quote();
        q.merchant = other;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.MerchantMismatch.selector));
    }

    // --------------------------------------------------------------- expiry

    function test_book_revertsWhenQuoteExpired() public {
        FlightEscrow.Quote memory q = _quote();
        vm.warp(q.expiresAt + 1);
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.QuoteExpired.selector));
    }

    function test_book_acceptsQuoteAtExpiry() public {
        FlightEscrow.Quote memory q = _quote();
        vm.warp(q.expiresAt);
        _bookOk(q);
    }

    function test_book_revertsWhenMandateExpired() public {
        FlightEscrow.Mandate memory m = _mandate();
        m.expiresAt = uint64(T0 - 1);
        _setMandate(m);
        _expectBookRevert(_quote(), abi.encodeWithSelector(FlightEscrow.MandateExpired.selector));
    }

    // --------------------------------------------------------------- replay

    function test_book_revertsWhenSameQuoteUsedTwice() public {
        FlightEscrow.Quote memory q = _quote();
        bytes32 bookingId = _bookOk(q);
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.BookingExists.selector, bookingId));
    }

    function test_book_revertsWhenAnotherAgentUsesTheQuote() public {
        address thief = makeAddr("thief");
        vm.deal(thief, 10 ether);
        vm.prank(owner);
        escrow.setMandate(thief, _mandate());

        FlightEscrow.Quote memory q = _quote(); // bound to `agent`
        bytes memory sig = _signQuote(q);
        vm.expectRevert(FlightEscrow.AgentMismatch.selector);
        vm.prank(thief);
        escrow.book{value: q.priceWei}(q, sig);
        assertEq(thief.balance, 10 ether, "thief locked nothing");
    }

    // -------------------------------------------------------------- payment

    function test_book_revertsOnOverpay() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory sig = _signQuote(q);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.WrongPayment.selector, q.priceWei, q.priceWei + 1));
        vm.prank(agent);
        escrow.book{value: q.priceWei + 1}(q, sig);
    }

    function test_book_revertsOnUnderpay() public {
        FlightEscrow.Quote memory q = _quote();
        bytes memory sig = _signQuote(q);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.WrongPayment.selector, q.priceWei, q.priceWei - 1));
        vm.prank(agent);
        escrow.book{value: q.priceWei - 1}(q, sig);
    }

    // --------------------------------------------------------- ticket window

    function test_book_revertsWhenTicketWindowUnder60s() public {
        FlightEscrow.Quote memory q = _quote();
        q.ticketWindow = 59;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.InvalidTicketWindow.selector, uint32(59)));
    }

    function test_book_revertsWhenTicketWindowOver24h() public {
        FlightEscrow.Quote memory q = _quote();
        q.ticketWindow = 24 hours + 1;
        _expectBookRevert(q, abi.encodeWithSelector(FlightEscrow.InvalidTicketWindow.selector, uint32(24 hours + 1)));
    }

    function test_book_acceptsTicketWindowBounds() public {
        FlightEscrow.Quote memory q = _quote();
        q.ticketWindow = 60;
        _bookOk(q);
        q.ticketWindow = 24 hours;
        _bookOk(q);
    }

    // ------------------------------------------------------------- re-set

    function test_setMandate_overwriteAppliesNewConditions() public {
        FlightEscrow.Mandate memory m = _mandate();
        m.cabin = FlightEscrow.Cabin.Business;
        _setMandate(m);
        _expectBookRevert(_quote(), abi.encodeWithSelector(FlightEscrow.CabinMismatch.selector));

        FlightEscrow.Quote memory q = _quote();
        q.cabin = FlightEscrow.Cabin.Business;
        _bookOk(q);
    }

    // -------------------------------------------------------------- helpers

    function _bookOk(FlightEscrow.Quote memory q) internal returns (bytes32) {
        bytes memory sig = _signQuote(q);
        vm.prank(agent);
        return escrow.book{value: q.priceWei}(q, sig);
    }

    function _expectBookRevert(FlightEscrow.Quote memory q, bytes memory reason) internal {
        bytes memory sig = _signQuote(q);
        uint256 agentBefore = agent.balance;
        vm.expectRevert(reason);
        vm.prank(agent);
        escrow.book{value: q.priceWei}(q, sig);
        assertEq(agent.balance, agentBefore, "agent keeps funds");
    }

    function _mandate() internal view returns (FlightEscrow.Mandate memory) {
        return FlightEscrow.Mandate({
            merchant: merchant,
            maxFareWei: 500 ether,
            maxTickets: 5,
            expiresAt: uint64(T0 + 7 days),
            origin: "TPE",
            destination: "TYO",
            departFrom: uint32(T0 / 1 days),
            departTo: uint32(T0 / 1 days + 30),
            cabin: FlightEscrow.Cabin.Economy,
            refundableOnly: false,
            mandateHash: keccak256("owner-approved mandate text")
        });
    }

    function _quote() internal view returns (FlightEscrow.Quote memory) {
        return FlightEscrow.Quote({
            merchant: merchant,
            agent: agent,
            owner: owner,
            offerId: keccak256("offer-1"),
            priceWei: 1 ether,
            origin: "TPE",
            destination: "TYO",
            departDay: uint32(T0 / 1 days + 10),
            cabin: FlightEscrow.Cabin.Economy,
            refundable: true,
            expiresAt: uint64(T0 + 15 minutes),
            ticketWindow: 1 hours
        });
    }

    function _setMandate(FlightEscrow.Mandate memory m) internal {
        vm.prank(owner);
        escrow.setMandate(agent, m);
    }

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

    function _filled(uint256 len, uint8 b) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = bytes1(b);
        }
    }
}
