// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Stand-in for the pqcVerify precompile (0x...0A01) that really verifies ML-DSA-87,
///         by shelling out to `scripts/escrow-ffi.ts verify` (noble post-quantum). Needs ffi.
/// @dev Declared non-view because vm.ffi isn't; the escrow still reaches it with a staticcall.
contract FfiPqcVerify {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        returns (bool)
    {
        if (message.length == 0) return false;
        string[] memory cmd = new string[](6);
        cmd[0] = "node_modules/.bin/tsx";
        cmd[1] = "scripts/escrow-ffi.ts";
        cmd[2] = "verify";
        cmd[3] = vm.toString(pubkey);
        cmd[4] = vm.toString(signature);
        cmd[5] = vm.toString(message);
        return abi.decode(vm.ffi(cmd), (bool));
    }
}
