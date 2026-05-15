// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceFeed
/// @notice Minimal Chainlink AggregatorV3-compatible interface.
///         Only the fields zstrategy needs at fill time.
interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        );

    function decimals() external view returns (uint8);
}
