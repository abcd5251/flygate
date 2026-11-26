// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProbeRecorder} from "../probe/ProbeRecorder.sol";

/// The probe reads these fields back after each diana call, so they must hold exactly what
/// the EVM delivered.
contract ProbeRecorderTest is Test {
    ProbeRecorder probe;
    address caller = makeAddr("caller");

    function setUp() public {
        probe = new ProbeRecorder();
        vm.deal(caller, 1 ether);
    }

    function test_allowedRecordsSenderValueAndSelector() public {
        vm.expectEmit(true, false, false, true, address(probe));
        emit ProbeRecorder.Called(caller, 123, ProbeRecorder.allowed.selector);
        vm.prank(caller);
        probe.allowed{value: 123}();
        assertEq(probe.lastSender(), caller);
        assertEq(probe.lastValue(), 123);
        assertEq(probe.lastSelector(), ProbeRecorder.allowed.selector);
        assertEq(probe.calls(), 1);
        assertEq(address(probe).balance, 123);
    }

    function test_blockedRecordsItsOwnSelector() public {
        vm.prank(caller);
        probe.blocked();
        assertEq(probe.lastSelector(), ProbeRecorder.blocked.selector);
        assertEq(probe.calls(), 1);
    }

    function test_selectorsDiffer() public pure {
        assertTrue(ProbeRecorder.allowed.selector != ProbeRecorder.blocked.selector);
    }
}
