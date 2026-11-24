// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FlightEscrow
/// @notice Holds an agent's flight payment until the merchant proves the ticket was issued.
///         Merchant authority comes only from ML-DSA-87 signatures verified by QoreChain's
///         PQC precompiles, so the contract can live only on diana (chain id 9800). No admin.
contract FlightEscrow {
    uint256 public constant DIANA_CHAIN_ID = 9800;

    error WrongChain(uint256 chainId);

    constructor() {
        if (block.chainid != DIANA_CHAIN_ID) revert WrongChain(block.chainid);
    }
}
