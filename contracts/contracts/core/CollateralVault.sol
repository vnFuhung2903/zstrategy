// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract CollateralVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    address public registry;
    mapping(address user => mapping(address token => uint256)) public freeBalance;

    mapping(bytes32 commitmentHash => mapping(address token => uint256)) public lockedBalance;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event CollateralLocked(bytes32 indexed commitmentHash, address indexed token, uint256 amount);
    event CollateralReleased(bytes32 indexed commitmentHash, address indexed token, uint256 amount, address indexed to);
    event CollateralReturned(bytes32 indexed commitmentHash, address indexed user, address indexed token, uint256 amount);
    event RegistryChanged(address indexed oldRegistry, address indexed newRegistry);

    constructor() Ownable(msg.sender) {}

    function setRegistry(address _registry) external onlyOwner {
        require(_registry != address(0), "Vault: zero registry");
        emit RegistryChanged(registry, _registry);
        registry = _registry;
    }

    modifier onlyRegistry() {
        require(msg.sender == registry, "Vault: caller not registry");
        _;
    }

    function deposit(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        freeBalance[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "Vault: zero amount");
        require(freeBalance[msg.sender][token] >= amount, "Vault: insufficient free balance");
        freeBalance[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

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
