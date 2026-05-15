// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDEXAdapter.sol";

/// @notice Minimal Uniswap v3 SwapRouter interface (exactInputSingle only).
interface ISwapRouter {
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

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @title UniswapV3Adapter
/// @notice Wraps Uniswap v3 SwapRouter to conform to IDEXAdapter.
///         Sets a one-time max-allowance to the router on first encounter of each token,
///         saving ~25k gas per subsequent swap. Uses OZ forceApprove to handle non-standard
///         ERC-20s (e.g., USDT) that revert on non-zero re-approval.
contract UniswapV3Adapter is IDEXAdapter {
    using SafeERC20 for IERC20;

    ISwapRouter public immutable router;
    uint24 public immutable feeTier;
    /// @notice Seconds added to block.timestamp when computing the swap deadline.
    ///         Set at deploy time. Re-deploy with a different value to change.
    uint256 public immutable swapDeadlineBuffer;

    /// @dev Tokens whose router allowance has already been set to type(uint256).max.
    mapping(address token => bool) private routerApproved;

    constructor(address _router, uint24 _feeTier, uint256 _swapDeadlineBuffer) {
        require(_swapDeadlineBuffer > 0, "Adapter: zero deadline buffer");
        router             = ISwapRouter(_router);
        feeTier            = _feeTier;
        swapDeadlineBuffer = _swapDeadlineBuffer;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external override returns (uint256 amountOut) {
        // Tokens are sent to this contract by CollateralVault.releaseForExecution before swap().
        if (!routerApproved[tokenIn]) {
            IERC20(tokenIn).forceApprove(address(router), type(uint256).max);
            routerApproved[tokenIn] = true;
        }

        amountOut = router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn:           tokenIn,
                tokenOut:          tokenOut,
                fee:               feeTier,
                recipient:         recipient,
                deadline:          block.timestamp + swapDeadlineBuffer,
                amountIn:          amountIn,
                amountOutMinimum:  minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
