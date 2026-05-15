// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDEXAdapter
/// @notice Adapter interface for DEX integrations. Core contracts depend only on this interface.
interface IDEXAdapter {
    /// @notice Execute a token swap.
    /// @param tokenIn   Address of the input token.
    /// @param tokenOut  Address of the output token.
    /// @param amountIn  Exact amount of tokenIn to sell.
    /// @param minOut    Minimum amount of tokenOut to accept (slippage guard).
    /// @param recipient Address that receives tokenOut.
    /// @return amountOut Actual amount of tokenOut received.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
