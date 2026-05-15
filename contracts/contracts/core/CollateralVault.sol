// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CollateralVault
/// @notice Holds user collateral for zstrategy commitments.
///         Only the CommitmentRegistry may move locked funds.
///
/// Flow:
///   user.deposit()        → free balance increases
///   registry.lock()       → free → locked (per commitment)
///   registry.release()    → locked transferred to DEX adapter for swap
///   registry.return()     → locked returned to free (on cancel / expiry)
contract CollateralVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State ──────────────────────────────────────────────────────────────

    address public registry;
    address public owner;

    /// @notice Free (unlocked) balance per user per token.
    mapping(address user => mapping(address token => uint256)) public freeBalance;

    /// @notice Locked balance per commitment per token.
    mapping(bytes32 commitmentHash => mapping(address token => uint256)) public lockedBalance;

    // ── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event CollateralLocked(bytes32 indexed commitmentHash, address indexed token, uint256 amount);
    event CollateralReleased(bytes32 indexed commitmentHash, address indexed token, uint256 amount, address indexed to);
    event CollateralReturned(bytes32 indexed commitmentHash, address indexed user, address indexed token, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    /// @notice Set the registry address once after deployment (breaks circular deploy dependency).
    function setRegistry(address _registry) external {
        require(msg.sender == owner,    "Vault: not owner");
        require(registry == address(0), "Vault: registry already set");
        require(_registry != address(0), "Vault: zero registry");
        registry = _registry;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyRegistry() {
        require(msg.sender == registry, "Vault: caller not registry");
        _;
    }

    // ── User-facing functions ──────────────────────────────────────────────

    /// @notice Deposit ERC-20 tokens into the vault.
    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        freeBalance[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraw free (unlocked) tokens from the vault.
    function withdraw(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero amount");
        require(freeBalance[msg.sender][token] >= amount, "Vault: insufficient free balance");
        freeBalance[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ── Registry-only functions ────────────────────────────────────────────

    /// @notice Lock `amount` of `token` from `user`'s free balance under `commitmentHash`.
    ///         Called by registry during registerCommitment.
    function lockCollateral(
        bytes32 commitmentHash,
        address user,
        address token,
        uint256 amount
    ) external onlyRegistry {
        require(freeBalance[user][token] >= amount, "Vault: insufficient free balance");
        freeBalance[user][token]            -= amount;
        lockedBalance[commitmentHash][token] += amount;
        emit CollateralLocked(commitmentHash, token, amount);
    }

    /// @notice Transfer locked collateral to `to` (the DEX adapter) for execution.
    ///         Called by registry during executeCommitment.
    function releaseForExecution(
        bytes32 commitmentHash,
        address token,
        uint256 amount,
        address to
    ) external onlyRegistry {
        require(lockedBalance[commitmentHash][token] >= amount, "Vault: insufficient locked balance");
        lockedBalance[commitmentHash][token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit CollateralReleased(commitmentHash, token, amount, to);
    }

    /// @notice Return locked collateral back to `user`'s free balance.
    ///         Called by registry on cancelCommitment or sweepExpired.
    function returnCollateral(
        bytes32 commitmentHash,
        address user,
        address token,
        uint256 amount
    ) external onlyRegistry {
        require(lockedBalance[commitmentHash][token] >= amount, "Vault: insufficient locked balance");
        lockedBalance[commitmentHash][token] -= amount;
        freeBalance[user][token]             += amount;
        emit CollateralReturned(commitmentHash, user, token, amount);
    }
}
