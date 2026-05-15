// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IDEXAdapter.sol";
import "../interfaces/IPriceFeed.sol";
import "./CollateralVault.sol";
import "./GasVault.sol";

/// @title CommitmentRegistry
/// @notice Trust root of zstrategy. Stores privacy-preserving trading commitments
///         and executes them against a DEX adapter when a valid ZK proof is provided.
///
/// State machine per commitment:
///   NONE → PENDING → EXECUTED
///                  → CANCELLED
///                  → EXPIRED  (via sweepExpired)
contract CommitmentRegistry is ReentrancyGuard {

    // ── Enums & Structs ────────────────────────────────────────────────────

    enum CommitmentStatus { NONE, PENDING, EXECUTED, CANCELLED, EXPIRED }

    /// @notice Determines which verifier and public-input layout to use at execution.
    ///         ORDER_FILL (0): reads Chainlink oracle price; verifier = verifiers[0].
    ///         DCA        (1): uses block.timestamp as fill time; verifier = verifiers[1].
    enum CommitmentKind { ORDER_FILL, DCA }

    struct CommitmentRecord {
        // Slot 0 — packed (20 + 8 + 1 + 1 = 30 bytes ≤ 32)
        address          owner;    // User who registered this commitment
        uint64           expiry;   // Unix timestamp after which commitment is expired
        CommitmentStatus status;
        CommitmentKind   kind;
        // Slot 1
        address  tokenIn;          // Collateral token (token being sold / spent)
        // Slot 2
        address  tokenOut;         // Token to receive after swap
        // Slot 3
        uint256  size;             // Amount of tokenIn locked in vault
        // Slot 4
        uint256  minOut;           // Minimum tokenOut (slippage protection; encrypted pre-execution)
    }

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice Per-kind verifier registry. Set via setVerifier(); never immutable so
    ///         new circuit versions can be deployed without redeploying the registry.
    ///         verifiers[0] = ORDER_FILL (UltraHonk, Chainlink public input)
    ///         verifiers[1] = DCA        (UltraHonk, block.timestamp public input)
    mapping(uint8 => IVerifier) public verifiers;
    CollateralVault public immutable vault;
    IDEXAdapter     public           dexAdapter;

    /// @notice Prepaid gas-tank vault. When set, executeCommitment debits the
    ///         strategy owner's balance and forwards ETH to the keeper EOA
    ///         (`msg.sender`) at fill time. Self-execution (owner == sender)
    ///         skips the debit. Zero address means the gas tank is disabled —
    ///         used for older test fixtures that don't deploy GasVault.
    GasVault        public           gasVault;

    address public guardian;
    bool    public paused;

    /// @notice Volume tracking for circuit breaker: per-token rolling 1-hour window.
    ///         Sums across tokens are nonsensical (different decimals + denominations),
    ///         so each tokenIn has its own baseline + window.
    mapping(address tokenIn => uint256) public volumeBaseline;
    mapping(address tokenIn => uint256) public currentHourVolume;
    mapping(address tokenIn => uint256) public currentHourStart;
    uint256 public constant CIRCUIT_BREAKER_MULTIPLIER = 10;
    uint256 public constant HOUR = 3600;

    /// @notice Keeper reimbursement = gasUsed × tx.gasprice × (BPS / 10000).
    ///         12000 = 120% — flat 20% premium over raw cost.
    uint256 public constant KEEPER_PREMIUM_BPS = 12000;

    /// @notice Fixed gas estimate for the post-measurement ops (the debit call
    ///         + Debited/CommitmentExecuted events). Calibrated empirically;
    ///         a small over-estimate is preferable to under-paying the keeper.
    uint256 public constant GAS_OVERHEAD = 30000;

    /// @notice Maximum age of a Chainlink answer accepted at fill time.
    ///         Defaults to 1 hour; guardian may widen for feeds with longer heartbeat.
    uint256 public oracleStaleness = 1 hours;

    /// @notice Per-pair Chainlink price feeds. tokenIn → tokenOut → feed.
    ///         Quote convention: feed reports the price of tokenIn denominated in tokenOut.
    mapping(address tokenIn => mapping(address tokenOut => IPriceFeed)) public priceFeeds;

    mapping(bytes32 => CommitmentRecord) public commitments;
    mapping(bytes32 => bool)             public nullifiers;

    // ── Events ─────────────────────────────────────────────────────────────

    event CommitmentRegistered(
        bytes32        indexed commitmentHash,
        address        indexed owner,
        address        tokenIn,
        address        tokenOut,
        uint256        size,
        uint64         expiry,
        CommitmentKind kind
    );
    event VerifierSet(uint8 indexed kind, address indexed verifier);
    /// @notice Audit trail for fill events (Path B1 threshold-keeper).
    ///         `executor` is `msg.sender` — the keeper EOA (or user wallet, for
    ///         self-execution) that submitted this fill. Indexed so observers
    ///         can filter "show all fills by keeper-X" via standard event logs.
    event CommitmentExecuted(
        bytes32        indexed commitmentHash,
        address        indexed owner,
        address        indexed executor,
        bytes32        nullifier,
        uint64         fillRef,   // oracle price for ORDER_FILL; block.timestamp for DCA
        uint256        amountOut,
        CommitmentKind kind
    );
    event CommitmentCancelled(bytes32 indexed commitmentHash, address indexed owner);
    event CommitmentExpired(bytes32 indexed commitmentHash, address indexed owner);
    event DEXAdapterChanged(address indexed oldAdapter, address indexed newAdapter);
    event GasVaultChanged(address indexed oldVault, address indexed newVault);
    event PriceFeedSet(address indexed tokenIn, address indexed tokenOut, address indexed feed);
    event OracleStalenessSet(uint256 oldValue, uint256 newValue);
    event Paused(address indexed guardian);
    event Unpaused(address indexed guardian);

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(
        address _verifier,
        address _vault,
        address _dexAdapter,
        address _guardian
    ) {
        require(_verifier   != address(0), "Registry: zero verifier");
        require(_vault      != address(0), "Registry: zero vault");
        require(_dexAdapter != address(0), "Registry: zero adapter");
        require(_guardian   != address(0), "Registry: zero guardian");

        verifiers[uint8(CommitmentKind.ORDER_FILL)] = IVerifier(_verifier);
        vault      = CollateralVault(_vault);
        dexAdapter = IDEXAdapter(_dexAdapter);
        guardian   = _guardian;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        require(!paused, "Registry: paused");
        _;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "Registry: caller not guardian");
        _;
    }

    // ── Registration ──────────────────────────────────────────────────────

    /// @notice Register a privacy-preserving trading commitment.
    /// @param commitmentHash  keccak256 of the strategy preimage
    /// @param tokenIn         Token being sold / collateral token
    /// @param tokenOut        Token to receive
    /// @param size            Amount of tokenIn to lock from vault
    /// @param minOut          Minimum tokenOut accepted at execution (slippage guard)
    /// @param expiry          Unix timestamp after which commitment can be swept
    /// @param kind            Verifier dispatch key (ORDER_FILL or DCA)
    function registerCommitment(
        bytes32        commitmentHash,
        address        tokenIn,
        address        tokenOut,
        uint256        size,
        uint256        minOut,
        uint64         expiry,
        CommitmentKind kind
    ) external nonReentrant whenNotPaused {
        require(commitmentHash != bytes32(0),          "Registry: zero hash");
        require(tokenIn  != address(0),                "Registry: zero tokenIn");
        require(tokenOut != address(0),                "Registry: zero tokenOut");
        require(tokenIn  != tokenOut,                  "Registry: same token");
        require(size > 0,                              "Registry: zero size");
        require(expiry > block.timestamp,              "Registry: expiry in past");
        require(
            address(verifiers[uint8(kind)]) != address(0),
            "Registry: verifier not set for kind"
        );
        require(
            commitments[commitmentHash].status == CommitmentStatus.NONE,
            "Registry: duplicate commitment"
        );

        commitments[commitmentHash] = CommitmentRecord({
            owner:    msg.sender,
            tokenIn:  tokenIn,
            tokenOut: tokenOut,
            size:     size,
            minOut:   minOut,
            expiry:   expiry,
            status:   CommitmentStatus.PENDING,
            kind:     kind
        });

        vault.lockCollateral(commitmentHash, msg.sender, tokenIn, size);

        emit CommitmentRegistered(commitmentHash, msg.sender, tokenIn, tokenOut, size, expiry, kind);
    }

    /// @notice Batch-register up to 10 commitments in a single transaction (e.g. for DCA rounds).
    /// @param kind  Applied to every commitment in the batch (all rounds share the same verifier).
    function registerCommitmentBatch(
        bytes32[]      calldata commitmentHashes,
        address        tokenIn,
        address        tokenOut,
        uint256[]      calldata sizes,
        uint256[]      calldata minOuts,
        uint64[]       calldata expiries,
        CommitmentKind kind
    ) external nonReentrant whenNotPaused {
        uint256 n = commitmentHashes.length;
        require(n > 0 && n <= 10,          "Registry: batch size 1-10");
        require(sizes.length    == n,      "Registry: sizes length mismatch");
        require(minOuts.length  == n,      "Registry: minOuts length mismatch");
        require(expiries.length == n,      "Registry: expiries length mismatch");
        require(
            address(verifiers[uint8(kind)]) != address(0),
            "Registry: verifier not set for kind"
        );

        for (uint256 i = 0; i < n; i++) {
            bytes32 h = commitmentHashes[i];
            require(h != bytes32(0),                                  "Registry: zero hash");
            require(sizes[i] > 0,                                     "Registry: zero size");
            require(expiries[i] > block.timestamp,                    "Registry: expiry in past");
            require(commitments[h].status == CommitmentStatus.NONE,   "Registry: duplicate commitment");

            commitments[h] = CommitmentRecord({
                owner:    msg.sender,
                tokenIn:  tokenIn,
                tokenOut: tokenOut,
                size:     sizes[i],
                minOut:   minOuts[i],
                expiry:   expiries[i],
                status:   CommitmentStatus.PENDING,
                kind:     kind
            });

            vault.lockCollateral(h, msg.sender, tokenIn, sizes[i]);

            emit CommitmentRegistered(h, msg.sender, tokenIn, tokenOut, sizes[i], expiries[i], kind);
        }
    }

    // ── Execution ──────────────────────────────────────────────────────────

    /// @notice Execute a commitment by providing a valid ZK proof.
    ///         Can be called by the keeper or by the user themselves (self-execution fallback).
    ///
    ///         The oracle price is read from the configured Chainlink feed at execution
    ///         time and used as the public input to the verifier — callers cannot supply
    ///         it. The user therefore must produce a proof bound to the live feed value
    ///         (not a pre-computed value).
    /// @param commitmentHash  The commitment to execute.
    /// @param nullifier       Prevents double-execution (public output of ZK circuit).
    /// @param proof           Serialised UltraPlonk proof bytes.
    function executeCommitment(
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes calldata proof
    ) external nonReentrant whenNotPaused {
        uint256 gasStart = gasleft();
        CommitmentRecord storage c = commitments[commitmentHash];

        require(c.status == CommitmentStatus.PENDING, "Registry: not pending");
        require(block.timestamp <= c.expiry,          "Registry: expired");
        require(!nullifiers[nullifier],               "Registry: nullifier spent");

        IVerifier kv = verifiers[uint8(c.kind)];
        require(address(kv) != address(0), "Registry: verifier not set for kind");

        // ── Build public inputs and read fill-time reference value ─────────
        // Public input layout is identical for both circuits:
        //   [0] commitment_hash  [1] fill_ref (oracle price or block.timestamp)
        //   [2] nullifier        [3] token_in   [4] token_out
        //   [5] size             [6] min_out     [7] expiry
        bytes32[] memory publicInputs = new bytes32[](8);
        publicInputs[0] = commitmentHash;
        publicInputs[2] = nullifier;
        publicInputs[3] = bytes32(uint256(uint160(c.tokenIn)));
        publicInputs[4] = bytes32(uint256(uint160(c.tokenOut)));
        publicInputs[5] = bytes32(c.size);
        publicInputs[6] = bytes32(c.minOut);
        publicInputs[7] = bytes32(uint256(c.expiry));

        uint64 fillRef;
        if (c.kind == CommitmentKind.ORDER_FILL) {
            fillRef = _readOraclePrice(c.tokenIn, c.tokenOut);
        } else {
            // DCA: fill-time reference is the current block timestamp.
            fillRef = uint64(block.timestamp);
        }
        publicInputs[1] = bytes32(uint256(fillRef));

        require(kv.verify(proof, publicInputs), "Registry: invalid proof");

        // ── Mark before external calls (CEI pattern) ──────────────────────
        nullifiers[nullifier] = true;
        c.status = CommitmentStatus.EXECUTED;

        // ── Release collateral to DEX adapter and swap ────────────────────
        vault.releaseForExecution(commitmentHash, c.tokenIn, c.size, address(dexAdapter));

        uint256 amountOut = dexAdapter.swap(
            c.tokenIn,
            c.tokenOut,
            c.size,
            c.minOut,
            c.owner
        );

        // ── Circuit breaker volume tracking ───────────────────────────────
        _trackVolume(c.tokenIn, c.size);

        // ── Gas-tank debit ────────────────────────────────────────────────
        // Reimburse the keeper from the owner's prepaid ETH balance with a
        // flat KEEPER_PREMIUM_BPS premium. Skipped on self-execute (refunding
        // to oneself just burns gas) and when gasVault isn't wired (back-compat
        // for tests/early deploys). Extracted to a helper to keep
        // executeCommitment under Solidity's stack-depth limit.
        _debitGas(c.owner, gasStart, commitmentHash);

        emit CommitmentExecuted(commitmentHash, c.owner, msg.sender, nullifier, fillRef, amountOut, c.kind);
    }

    /// @dev Read the configured Chainlink feed for (tokenIn → tokenOut), validate
    ///      freshness and positivity, then narrow to uint64 with overflow check.
    function _readOraclePrice(address tokenIn, address tokenOut) internal view returns (uint64) {
        IPriceFeed feed = priceFeeds[tokenIn][tokenOut];
        require(address(feed) != address(0), "Registry: no price feed");

        (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
        require(answer > 0,                                       "Registry: invalid oracle answer");
        require(updatedAt > 0,                                    "Registry: incomplete round");
        require(block.timestamp - updatedAt <= oracleStaleness,   "Registry: stale oracle");

        uint256 priceU = uint256(answer);
        require(priceU <= type(uint64).max, "Registry: oracle price overflow");

        return uint64(priceU);
    }

    // ── Cancellation ──────────────────────────────────────────────────────

    /// @notice Cancel a pending commitment and return collateral to vault free balance.
    ///         Only the commitment owner may cancel.
    /// @param commitmentHash  The commitment to cancel.
    /// @param nullifier       The nullifier for this commitment (prevents replay after cancel).
    function cancelCommitment(bytes32 commitmentHash, bytes32 nullifier) external nonReentrant {
        CommitmentRecord storage c = commitments[commitmentHash];

        require(c.owner == msg.sender,                "Registry: not owner");
        require(c.status == CommitmentStatus.PENDING, "Registry: not pending");
        require(!nullifiers[nullifier],               "Registry: nullifier spent");

        nullifiers[nullifier] = true;
        c.status = CommitmentStatus.CANCELLED;

        vault.returnCollateral(commitmentHash, msg.sender, c.tokenIn, c.size);

        emit CommitmentCancelled(commitmentHash, msg.sender);
    }

    /// @notice Sweep one or more expired commitments, returning collateral to owners.
    ///         Callable by anyone — no trust required.
    function sweepExpired(bytes32[] calldata commitmentHashes) external nonReentrant {
        for (uint256 i = 0; i < commitmentHashes.length; i++) {
            bytes32 h = commitmentHashes[i];
            CommitmentRecord storage c = commitments[h];

            if (c.status != CommitmentStatus.PENDING) continue;
            if (block.timestamp <= c.expiry)          continue;

            c.status = CommitmentStatus.EXPIRED;

            vault.returnCollateral(h, c.owner, c.tokenIn, c.size);

            emit CommitmentExpired(h, c.owner);
        }
    }

    // ── View ───────────────────────────────────────────────────────────────

    function getCommitmentStatus(bytes32 commitmentHash)
        external
        view
        returns (CommitmentStatus)
    {
        return commitments[commitmentHash].status;
    }

    function getCommitment(bytes32 commitmentHash)
        external
        view
        returns (CommitmentRecord memory)
    {
        return commitments[commitmentHash];
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    function pause() external onlyGuardian {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyGuardian {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setDEXAdapter(address newAdapter) external onlyGuardian {
        require(newAdapter != address(0), "Registry: zero adapter");
        emit DEXAdapterChanged(address(dexAdapter), newAdapter);
        dexAdapter = IDEXAdapter(newAdapter);
    }

    /// @notice Wire (or rewire) the gas tank. Passing the zero address disables
    ///         the debit path — useful for test fixtures and emergency disable.
    function setGasVault(address newVault) external onlyGuardian {
        emit GasVaultChanged(address(gasVault), newVault);
        gasVault = GasVault(payable(newVault));
    }

    function setGuardian(address newGuardian) external onlyGuardian {
        require(newGuardian != address(0), "Registry: zero guardian");
        guardian = newGuardian;
    }

    /// @notice Calibrate the per-token baseline after the protocol has been live for a while.
    ///         Each tokenIn has its own baseline because volume cannot be summed across
    ///         tokens with different decimals / denominations.
    function setVolumeBaseline(address tokenIn, uint256 baseline) external onlyGuardian {
        require(tokenIn != address(0), "Registry: zero tokenIn");
        volumeBaseline[tokenIn] = baseline;
    }

    /// @notice Configure the Chainlink-compatible feed for a (tokenIn → tokenOut) pair.
    ///         Pass the zero address to remove the feed.
    function setPriceFeed(address tokenIn, address tokenOut, address feed) external onlyGuardian {
        require(tokenIn  != address(0), "Registry: zero tokenIn");
        require(tokenOut != address(0), "Registry: zero tokenOut");
        require(tokenIn  != tokenOut,   "Registry: same token");

        priceFeeds[tokenIn][tokenOut] = IPriceFeed(feed);
        emit PriceFeedSet(tokenIn, tokenOut, feed);
    }

    /// @notice Adjust the maximum accepted age of a Chainlink answer.
    ///         Default is 1 hour; widen for feeds with longer heartbeat.
    function setOracleStaleness(uint256 newValue) external onlyGuardian {
        require(newValue > 0, "Registry: zero staleness");
        emit OracleStalenessSet(oracleStaleness, newValue);
        oracleStaleness = newValue;
    }

    /// @notice Register or update the ZK verifier for a commitment kind.
    ///         Must be called for CommitmentKind.DCA before any DCA commitments can be registered.
    /// @param kind     0 = ORDER_FILL, 1 = DCA (cast from CommitmentKind enum)
    /// @param verifier Address of the deployed IVerifier contract.
    function setVerifier(uint8 kind, address verifier) external onlyGuardian {
        require(verifier != address(0), "Registry: zero verifier");
        verifiers[kind] = IVerifier(verifier);
        emit VerifierSet(kind, verifier);
    }

    // ── Internal ───────────────────────────────────────────────────────────

    /// @dev Compute reimbursement cost and forward it to the keeper EOA.
    ///      No-op when the gas tank is disabled or when the owner self-executed.
    function _debitGas(address owner_, uint256 gasStart, bytes32 commitmentHash) internal {
        if (address(gasVault) == address(0) || msg.sender == owner_) return;
        uint256 cost = ((gasStart - gasleft() + GAS_OVERHEAD) * tx.gasprice * KEEPER_PREMIUM_BPS) / 10000;
        gasVault.debit(owner_, payable(msg.sender), cost, commitmentHash);
    }

    /// @dev Track rolling 1-hour volume per tokenIn and auto-pause on >10× baseline spike.
    function _trackVolume(address tokenIn, uint256 amount) internal {
        if (block.timestamp >= currentHourStart[tokenIn] + HOUR) {
            currentHourVolume[tokenIn] = 0;
            currentHourStart[tokenIn]  = block.timestamp;
        }
        currentHourVolume[tokenIn] += amount;

        uint256 baseline = volumeBaseline[tokenIn];
        if (
            baseline > 0 &&
            currentHourVolume[tokenIn] > baseline * CIRCUIT_BREAKER_MULTIPLIER
        ) {
            paused = true;
            emit Paused(address(this));
        }
    }
}
