// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FlightEscrow} from "../FlightEscrow.sol";

/// @notice Deploys FlightEscrow to diana. The constructor reverts on any other chain.
///         `pnpm escrow:deploy` runs this WITHOUT --broadcast, as a simulation from the owner
///         signer (--sender), then signs and sends the recorded CREATE itself: forge re-sends
///         a refused broadcast on its own, and diana's EVM lane first needs a registered PQC
///         key and an open EVM window, which the wrapper sets up. Forge never sees a key.
///           forge script contracts/script/DeployFlightEscrow.s.sol \
///             --rpc-url https://evm-testnet.qore.host --sender <owner signer>
contract DeployFlightEscrow is Script {
    function run() external returns (FlightEscrow escrow) {
        vm.startBroadcast();
        escrow = new FlightEscrow();
        vm.stopBroadcast();
        console.log("FlightEscrow", address(escrow));
    }
}
