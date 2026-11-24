// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev QoreChain PQC precompile: ML-DSA-87 verification over raw message bytes (diana only).
interface IPqcVerify {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);
}

/// @dev QoreChain PQC precompile: the PQC key an address registered on chain.
interface IPqcKeyStatus {
    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @title FlightEscrow
/// @notice Holds an agent's flight payment until the merchant proves the ticket was issued.
///         Merchant authority comes only from ML-DSA-87 signatures verified by QoreChain's
///         PQC precompiles, so the contract can live only on diana (chain id 9800). No admin.
contract FlightEscrow {
    // ------------------------------------------------------------------ constants

    uint256 public constant DIANA_CHAIN_ID = 9800;
    IPqcVerify public constant PQC_VERIFY = IPqcVerify(0x0000000000000000000000000000000000000a01);
    IPqcKeyStatus public constant PQC_KEY_STATUS = IPqcKeyStatus(0x0000000000000000000000000000000000000a02);
    uint8 public constant ALGORITHM_ML_DSA_87 = 1;

    /// @notice Bounds on the merchant's exclusive ticketing window, in seconds.
    uint32 public constant MIN_TICKET_WINDOW = 60;
    uint32 public constant MAX_TICKET_WINDOW = 24 hours;

    /// @notice Domain tags mixed into every signed digest so one proof type can't pose as another.
    bytes32 public constant QUOTE_TYPE = keccak256("QUOTE");
    bytes32 public constant TICKET_TYPE = keccak256("TICKET");
    bytes32 public constant CANCEL_TYPE = keccak256("CANCEL");

    /// @notice QoreSign signArbitrary prefix for diana; followed by "0x" + lowercase hex digest.
    bytes public constant MESSAGE_PREFIX = "qorechain-msg-v1|qorechain-diana|0x";

    // ---------------------------------------------------------------------- types

    enum Cabin {
        Economy,
        PremiumEconomy,
        Business,
        First
    }

    enum Status {
        None,
        Locked,
        Released,
        Refunded
    }

    enum RefundReason {
        Cancelled,
        Expired
    }

    /// @notice The owner's spending rules for one agent.
    struct Mandate {
        address merchant;
        uint256 maxFareWei;
        uint32 maxTickets;
        uint64 expiresAt; // unix seconds
        bytes3 origin; // city code, e.g. "TPE"
        bytes3 destination; // city code, e.g. "TYO"
        uint32 departFrom; // unix day (timestamp / 1 days), inclusive
        uint32 departTo; // unix day, inclusive
        Cabin cabin;
        bool refundableOnly;
        bytes32 mandateHash; // hash of the off-chain mandate the owner approved
    }

    /// @notice A merchant-signed offer. keccak256(abi.encode(quote)) is the bookingId.
    ///         `owner` picks whose mandate the booking runs under and who gets refunds.
    struct Quote {
        address merchant;
        address agent;
        address owner;
        bytes32 offerId;
        uint256 priceWei;
        bytes3 origin; // city code
        bytes3 destination; // city code
        uint32 departDay; // unix day
        Cabin cabin;
        bool refundable;
        uint64 expiresAt; // unix seconds
        uint32 ticketWindow; // seconds after booking in which only the merchant can settle
    }

    /// @notice Merchant-signed proof the ticket was issued.
    struct TicketProof {
        bytes32 bookingId;
        bytes32 pnrHash; // keccak256 of PNR plus a passenger-held salt
        uint64 issuedAt;
    }

    /// @notice Merchant-signed proof the order failed.
    struct CancelProof {
        bytes32 bookingId;
        uint8 reasonCode;
    }

    struct AgentMandate {
        bool exists;
        bool revoked;
        uint32 ticketsUsed; // locked + released bookings; survives re-setting the mandate
        Mandate mandate;
    }

    struct Booking {
        Status status;
        address owner;
        address agent;
        address merchant;
        uint256 priceWei;
        uint64 deadline;
    }

    // ---------------------------------------------------------------------- state

    /// @dev Keyed by (owner, agent): a caller only ever writes its own slot, so nobody can
    ///      claim or overwrite another owner's mandate for the same agent.
    mapping(address owner => mapping(address agent => AgentMandate)) internal mandates;
    mapping(bytes32 bookingId => Booking) internal bookings;

    // --------------------------------------------------------------------- events

    event MandateSet(address indexed owner, address indexed agent, address indexed merchant, bytes32 mandateHash);
    event MandateRevoked(address indexed owner, address indexed agent);
    event Booked(
        bytes32 indexed bookingId, address indexed agent, address indexed merchant, uint256 priceWei, uint64 deadline
    );
    event Released(bytes32 indexed bookingId, bytes32 pnrHash);
    event Refunded(bytes32 indexed bookingId, RefundReason reason);

    // --------------------------------------------------------------------- errors

    error WrongChain(uint256 chainId);
    error NoMandate();
    error MerchantMismatch();
    error AgentMismatch();
    error WrongPayment(uint256 expected, uint256 actual);
    error BookingExists(bytes32 bookingId);
    error NotLocked(bytes32 bookingId);
    error TicketDeadlinePassed(bytes32 bookingId);
    error MerchantKeyNotRegistered(address merchant);
    error UnsupportedKeyAlgorithm(uint8 algorithmId);
    error MerchantKeyPossessionUnproven(address merchant);
    error InvalidSignature();
    error TransferFailed();
    error TicketDeadlineNotPassed(bytes32 bookingId);
    error TicketQuotaExhausted(uint32 maxTickets);
    error MandateIsRevoked();
    error MandateExpired();
    error FareOverCap(uint256 maxFareWei, uint256 priceWei);
    error RouteMismatch();
    error DepartDayOutOfRange(uint32 departDay);
    error CabinMismatch();
    error RefundableRequired();
    error QuoteExpired();
    error InvalidTicketWindow(uint32 ticketWindow);

    constructor() {
        if (block.chainid != DIANA_CHAIN_ID) revert WrongChain(block.chainid);
    }

    // ------------------------------------------------------------------- mandates

    /// @notice Set or overwrite the caller's mandate for `agent`. Re-setting keeps the
    ///         used-ticket count. It also re-enables an agent the caller revoked earlier:
    ///         signing a new mandate is how an owner undoes a revoke.
    function setMandate(address agent, Mandate calldata mandate) external {
        AgentMandate storage m = mandates[msg.sender][agent];
        m.exists = true;
        m.mandate = mandate;
        m.revoked = false;
        emit MandateSet(msg.sender, agent, mandate.merchant, mandate.mandateHash);
    }

    /// @notice Stop the agent from booking under the caller's mandate. Bookings already locked
    ///         are unaffected; a later setMandate by the caller re-enables the agent.
    function revokeMandate(address agent) external {
        AgentMandate storage m = mandates[msg.sender][agent];
        if (!m.exists) revert NoMandate();
        m.revoked = true;
        emit MandateRevoked(msg.sender, agent);
    }

    // ------------------------------------------------------------------- bookings

    /// @notice Lock exactly `quote.priceWei` against a merchant-signed quote, under the mandate
    ///         `quote.owner` set for the caller. Refunds go to `quote.owner`.
    function book(Quote calldata quote, bytes calldata signature) external payable returns (bytes32 bookingId) {
        AgentMandate storage m = mandates[quote.owner][msg.sender];
        if (!m.exists) revert NoMandate();
        if (m.revoked) revert MandateIsRevoked();
        if (block.timestamp > m.mandate.expiresAt) revert MandateExpired();
        if (quote.agent != msg.sender) revert AgentMismatch();
        if (quote.merchant != m.mandate.merchant) revert MerchantMismatch();
        if (msg.value != quote.priceWei) revert WrongPayment(quote.priceWei, msg.value);
        _checkMandateRules(m.mandate, quote);
        if (block.timestamp > quote.expiresAt) revert QuoteExpired();
        if (quote.ticketWindow < MIN_TICKET_WINDOW || quote.ticketWindow > MAX_TICKET_WINDOW) {
            revert InvalidTicketWindow(quote.ticketWindow);
        }

        bookingId = keccak256(abi.encode(quote));
        Booking storage b = bookings[bookingId];
        if (b.status != Status.None) revert BookingExists(bookingId);

        _verifyMerchant(quote.merchant, QUOTE_TYPE, abi.encode(quote), signature);

        uint64 deadline = uint64(block.timestamp) + quote.ticketWindow;
        if (m.ticketsUsed >= m.mandate.maxTickets) revert TicketQuotaExhausted(m.mandate.maxTickets);
        m.ticketsUsed += 1;
        bookings[bookingId] = Booking({
            status: Status.Locked,
            owner: quote.owner,
            agent: msg.sender,
            merchant: quote.merchant,
            priceWei: quote.priceWei,
            deadline: deadline
        });
        emit Booked(bookingId, msg.sender, quote.merchant, quote.priceWei, deadline);
    }

    /// @notice Release a locked booking to the merchant against a merchant-signed ticket proof.
    ///         Only until the ticketing deadline (inclusive).
    function confirmTicket(TicketProof calldata proof, bytes calldata signature) external {
        Booking storage b = bookings[proof.bookingId];
        if (b.status != Status.Locked) revert NotLocked(proof.bookingId);
        if (block.timestamp > b.deadline) revert TicketDeadlinePassed(proof.bookingId);

        _verifyMerchant(b.merchant, TICKET_TYPE, abi.encode(proof), signature);

        b.status = Status.Released;
        emit Released(proof.bookingId, proof.pnrHash);
        _send(b.merchant, b.priceWei);
    }

    // -------------------------------------------------------------------- refunds

    /// @notice Refund a locked booking to its owner against a merchant-signed cancel proof.
    ///         Callable by anyone, any time while Locked.
    function cancel(CancelProof calldata proof, bytes calldata signature) external {
        Booking storage b = bookings[proof.bookingId];
        if (b.status != Status.Locked) revert NotLocked(proof.bookingId);

        _verifyMerchant(b.merchant, CANCEL_TYPE, abi.encode(proof), signature);

        _refund(proof.bookingId, b, RefundReason.Cancelled);
    }

    /// @notice Refund a locked booking to its owner once the ticketing deadline has passed.
    ///         Callable by anyone; the money always goes to the owner.
    function refund(bytes32 bookingId) external {
        Booking storage b = bookings[bookingId];
        if (b.status != Status.Locked) revert NotLocked(bookingId);
        if (block.timestamp <= b.deadline) revert TicketDeadlineNotPassed(bookingId);

        _refund(bookingId, b, RefundReason.Expired);
    }

    // ------------------------------------------------------------------ internals

    /// @dev The on-chain repeat of the gate rules: fare cap, route, date range, cabin, refundability.
    function _checkMandateRules(Mandate storage mandate, Quote calldata quote) internal view {
        if (quote.priceWei > mandate.maxFareWei) revert FareOverCap(mandate.maxFareWei, quote.priceWei);
        if (quote.origin != mandate.origin || quote.destination != mandate.destination) revert RouteMismatch();
        if (quote.departDay < mandate.departFrom || quote.departDay > mandate.departTo) {
            revert DepartDayOutOfRange(quote.departDay);
        }
        if (quote.cabin != mandate.cabin) revert CabinMismatch();
        if (mandate.refundableOnly && !quote.refundable) revert RefundableRequired();
    }

    /// @dev Locked -> Refunded: pay the owner back and return one unit of the (owner, agent) quota.
    function _refund(bytes32 bookingId, Booking storage b, RefundReason reason) internal {
        b.status = Status.Refunded;
        mandates[b.owner][b.agent].ticketsUsed -= 1;
        emit Refunded(bookingId, reason);
        _send(b.owner, b.priceWei);
    }

    function _verifyMerchant(address merchant, bytes32 typeTag, bytes memory encodedStruct, bytes calldata signature)
        internal
        view
    {
        (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven) =
            PQC_KEY_STATUS.pqcKeyStatus(merchant);
        if (!registered) revert MerchantKeyNotRegistered(merchant);
        if (algorithmId != ALGORITHM_ML_DSA_87) revert UnsupportedKeyAlgorithm(algorithmId);
        if (!possessionProven) revert MerchantKeyPossessionUnproven(merchant);

        if (!PQC_VERIFY.pqcVerify(pubkey, signature, signedMessage(typeTag, encodedStruct))) {
            revert InvalidSignature();
        }
    }

    /// @notice The exact bytes the merchant signs:
    ///         MESSAGE_PREFIX + lowercase hex(keccak256(abi.encode(typeTag, chainid, this, struct))).
    /// @param encodedStruct abi.encode(struct) of a Quote, TicketProof or CancelProof.
    function signedMessage(bytes32 typeTag, bytes memory encodedStruct) public view returns (bytes memory) {
        bytes32 digest = keccak256(bytes.concat(abi.encode(typeTag, block.chainid, address(this)), encodedStruct));
        return bytes.concat(MESSAGE_PREFIX, _toHex(digest));
    }

    function _toHex(bytes32 value) internal pure returns (bytes memory out) {
        bytes16 digits = "0123456789abcdef";
        out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            uint8 byteValue = uint8(value[i]);
            out[2 * i] = digits[byteValue >> 4];
            out[2 * i + 1] = digits[byteValue & 0x0f];
        }
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
