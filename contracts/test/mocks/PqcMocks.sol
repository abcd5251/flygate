// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stand-in for the pqcVerify precompile (0x...0A01). A (pubkey, signature, message)
///         triple is valid only if a test allowlisted it.
contract MockPqcVerify {
    mapping(bytes32 => bool) private valid;

    function allow(bytes calldata pubkey, bytes calldata signature, bytes calldata message) external {
        valid[keccak256(abi.encode(pubkey, signature, message))] = true;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool)
    {
        if (message.length == 0) return false;
        return valid[keccak256(abi.encode(pubkey, signature, message))];
    }
}

/// @notice Stand-in for the pqcKeyStatus precompile (0x...0A02).
contract MockPqcKeyStatus {
    struct Status {
        bool registered;
        uint8 algorithmId;
        bytes pubkey;
        bool possessionProven;
    }

    mapping(address => Status) private statuses;

    function setStatus(address account, bool registered, uint8 algorithmId, bytes calldata pubkey, bool possessionProven)
        external
    {
        statuses[account] = Status(registered, algorithmId, pubkey, possessionProven);
    }

    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven)
    {
        Status storage s = statuses[account];
        return (s.registered, s.algorithmId, s.pubkey, s.possessionProven);
    }
}
