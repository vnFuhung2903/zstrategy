// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IVerifier.sol";

/// @notice Controllable mock verifier for Hardhat tests.
///         Returns `shouldPass` for all proofs; flip it to test rejection.
contract MockZKVerifier is IVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool v) external { shouldPass = v; }

    function verify(
        bytes calldata,
        bytes32[] calldata
    ) external view override returns (bool) {
        return shouldPass;
    }
}
