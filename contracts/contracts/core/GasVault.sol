// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GasVault
/// @notice Prepaid native-ETH balance per user. The CommitmentRegistry debits
///         from this pool at execute time and forwards the value to the keeper
///         EOA, reimbursing keeper gas with a flat premium.
///
/// Pooled (not per-strategy) — one deposit funds any number of commitments by
/// the same `msg.sender`. Users can withdraw unused balance at any time.
///
/// Flow:
///   user.deposit{value: X}()    → balanceOf[user] += X
///   registry.debit(user, kp, c) → balanceOf[user] -= cost; ETH → keeper
///   user.withdraw(amount)       → balanceOf[user] -= amount; ETH → user
contract GasVault is ReentrancyGuard {

    // ── State ──────────────────────────────────────────────────────────────

    address public registry;
    address public owner;

    /// @notice Prepaid gas balance per user, in wei.
    mapping(address user => uint256) public balanceOf;

    // ── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Debited(
        address indexed user,
        address indexed keeper,
        uint256         amount,
        bytes32 indexed commitmentHash
    );

    // ── Constructor ────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    /// @notice Set the registry address once after deployment (breaks circular
    ///         deploy dependency — same pattern as CollateralVault.setRegistry).
    function setRegistry(address _registry) external {
        require(msg.sender == owner,     "GasVault: not owner");
        require(registry == address(0),  "GasVault: registry already set");
        require(_registry != address(0), "GasVault: zero registry");
        registry = _registry;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyRegistry() {
        require(msg.sender == registry, "GasVault: not registry");
        _;
    }

    // ── User-facing functions ──────────────────────────────────────────────

    /// @notice Top up the caller's gas balance. Accepts raw `send` / `transfer`
    ///         via `receive()` below, or explicit `deposit()` for clarity.
    function deposit() external payable {
        require(msg.value > 0, "GasVault: zero deposit");
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    receive() external payable {
        require(msg.value > 0, "GasVault: zero deposit");
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw unused gas balance to the caller.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0,                       "GasVault: zero amount");
        require(balanceOf[msg.sender] >= amount,  "GasVault: insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "GasVault: transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ── Registry-only functions ────────────────────────────────────────────

    /// @notice Debit `user`'s gas balance and forward `amount` wei to `keeper`.
    ///         Called by CommitmentRegistry inside executeCommitment. Reverts
    ///         if balance is insufficient — caller (the registry) reverts the
    ///         whole execution, leaving the strategy PENDING.
    function debit(
        address          user,
        address payable  keeper,
        uint256          amount,
        bytes32          commitmentHash
    ) external onlyRegistry nonReentrant {
        require(balanceOf[user] >= amount, "GasVault: insufficient gas balance");
        balanceOf[user] -= amount;
        (bool ok, ) = keeper.call{value: amount}("");
        require(ok, "GasVault: keeper transfer failed");
        emit Debited(user, keeper, amount, commitmentHash);
    }
}
