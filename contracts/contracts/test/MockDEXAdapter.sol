// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IDEXAdapter.sol";

contract MockDEXAdapter is IDEXAdapter {
    uint256 public mockAmountOut;
    bool public revertAfterTransfer;

    constructor(uint256 _mockAmountOut) {
        mockAmountOut = _mockAmountOut;
    }

    function setMockAmountOut(uint256 amount) external {
        mockAmountOut = amount;
    }

    function setRevertAfterTransfer(bool enabled) external {
        revertAfterTransfer = enabled;
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

        require(IERC20(tokenIn).balanceOf(address(this)) >= amountIn, "MockDEX: insufficient tokenIn");
        IERC20(tokenOut).transfer(recipient, mockAmountOut);
        require(!revertAfterTransfer, "MockDEX: post-transfer failure");

        return mockAmountOut;
    }
}
