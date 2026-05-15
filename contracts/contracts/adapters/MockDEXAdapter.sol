// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IDEXAdapter.sol";

/// @title MockDEXAdapter
/// @notice Simulates a DEX swap for local Hardhat tests.
///         Transfers tokenIn from msg.sender and sends a configured amountOut of tokenOut.
///         In tests, seed this contract with output tokens before calling swap.
contract MockDEXAdapter is IDEXAdapter {
    /// @notice Fixed exchange rate: how many tokenOut units per 1e18 tokenIn units.
    ///         Set to 0 to make swaps revert (for failure testing).
    uint256 public mockAmountOut;

    constructor(uint256 _mockAmountOut) {
        mockAmountOut = _mockAmountOut;
    }

    function setMockAmountOut(uint256 amount) external {
        mockAmountOut = amount;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external override returns (uint256 amountOut) {
        require(mockAmountOut > 0, "MockDEX: swap disabled");
        require(mockAmountOut >= minOut, "MockDEX: slippage exceeded");

        // Tokens are already sent to this contract by CollateralVault.releaseForExecution
        // before swap() is called. We just verify we have them and send the output.
        require(IERC20(tokenIn).balanceOf(address(this)) >= amountIn, "MockDEX: insufficient tokenIn");
        IERC20(tokenOut).transfer(recipient, mockAmountOut);

        return mockAmountOut;
    }
}
