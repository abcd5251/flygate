// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlightEscrow} from "../FlightEscrow.sol";

contract FlightEscrowTest is Test {
    function test_deploy_revertsOffDiana() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(FlightEscrow.WrongChain.selector, 1));
        new FlightEscrow();
    }
}
