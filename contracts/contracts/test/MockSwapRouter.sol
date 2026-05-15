// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only stand-in for Uniswap v3 SwapRouter. Pulls `amountIn`
///         tokens from the caller (matching real router semantics) and pays
///         a configurable fixed `mockOut` to the recipient. Records the
///         `deadline` argument so tests can assert what the adapter passed.
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public lastDeadline;
    uint256 public mockOut;

    function setMockOut(uint256 v) external { mockOut = v; }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        returns (uint256 amountOut)
    {
        require(block.timestamp <= p.deadline, "MockRouter: deadline");
        lastDeadline = p.deadline;

        // Real router transfers tokenIn from caller and tokenOut to recipient.
        // We mimic the pull half so SafeERC20.forceApprove is exercised; we
        // skip the payout half because tests fund the recipient separately.
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);

        amountOut = mockOut;
    }
}
