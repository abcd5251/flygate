// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FlightEscrow} from "../FlightEscrow.sol";

/// @notice Deploys FlightEscrow to diana. The constructor reverts on any other chain.
///         Run through `pnpm escrow:deploy`, which derives the owner's EVM signer from
///         .env.local and passes it in DEPLOYER_PRIVATE_KEY (never written to disk).
///         By hand:
///           DEPLOYER_PRIVATE_KEY=0x... forge script contracts/script/DeployFlightEscrow.s.sol \
///             --rpc-url https://evm-testnet.qore.host --broadcast --slow
contract DeployFlightEscrow is Script {
    function run() external returns (FlightEscrow escrow) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        escrow = new FlightEscrow();
        vm.stopBroadcast();
        console.log("FlightEscrow", address(escrow));
    }
}
