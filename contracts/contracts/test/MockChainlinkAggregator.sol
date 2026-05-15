// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IPriceFeed.sol";

/// @notice Configurable Chainlink-compatible aggregator for Hardhat tests.
contract MockChainlinkAggregator is IPriceFeed {
    int256  private _answer;
    uint256 private _updatedAt;
    uint8   private immutable _decimals;
    uint80  private _roundId;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals  = decimals_;
        _answer    = initialAnswer;
        _updatedAt = block.timestamp;
        _roundId   = 1;
    }

    function setAnswer(int256 answer) external {
        _answer    = answer;
        _updatedAt = block.timestamp;
        _roundId  += 1;
    }

    function setUpdatedAt(uint256 t) external {
        _updatedAt = t;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }
}
