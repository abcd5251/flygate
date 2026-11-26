// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ProbeRecorder
/// @notice Throwaway target for `pnpm live:probe`: records who called, with how much, and
///         which function, so the probe can read back what diana actually delivered
///         (msg.sender of a MsgExecuteEVM, msg.value, and whether a selector rule let a call
///         through). Holds no funds of value and has no admin; deploy one per probe run.
contract ProbeRecorder {
    event Called(address indexed sender, uint256 value, bytes4 selector);

    address public lastSender;
    uint256 public lastValue;
    bytes4 public lastSelector;
    uint256 public calls;

    /// @notice The function the probe's spending rule allowlists.
    function allowed() external payable {
        _record();
    }

    /// @notice Same body, different selector: the spending rule must refuse it.
    function blocked() external payable {
        _record();
    }

    function _record() internal {
        lastSender = msg.sender;
        lastValue = msg.value;
        lastSelector = msg.sig;
        calls += 1;
        emit Called(msg.sender, msg.value, msg.sig);
    }
}
