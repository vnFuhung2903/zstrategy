// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IDEXAdapter.sol";
import "../interfaces/ISwapRouter.sol";

contract UniswapV3Adapter is IDEXAdapter {
    using SafeERC20 for IERC20;

    ISwapRouter public immutable router;
    uint24 public immutable feeTier;

    mapping(address token => bool) private routerApproved;

    constructor(address _router, uint24 _feeTier) {
        router             = ISwapRouter(_router);
        feeTier            = _feeTier;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external override returns (uint256 amountOut) {
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
                amountIn:          amountIn,
                // amountOutMinimum:  minOut,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
