// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerifier
/// @notice Interface for the auto-generated UltraHonk verifier contract
interface IVerifier {
    /// @notice Verify an UltraHonk proof.
    /// @param proof        The serialised proof bytes (public inputs stripped — supplied separately).
    /// @param publicInputs Public inputs
    /// @return True if the proof is valid.
    function verify(
        bytes calldata proof,
        bytes32[] calldata publicInputs
    ) external view returns (bool);
}
