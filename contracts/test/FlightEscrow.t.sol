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

    // --------------------------------------------------------------- helpers

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
        for (uint256 i; i < len; ++i) out[i] = bytes1(b);
    }
}
