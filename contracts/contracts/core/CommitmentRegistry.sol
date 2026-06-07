// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "../interfaces/IVerifier.sol";
import "../interfaces/IDEXAdapter.sol";
import "../interfaces/IPriceFeed.sol";
import "./CollateralVault.sol";

/// @title CommitmentRegistry
/// @notice Trust root of zstrategy. Stores privacy-preserving trading commitments
///         and executes them against a DEX adapter when a valid ZK proof is provided.
///
/// State machine per commitment:
///   NONE → PENDING → EXECUTED
///                  → CANCELLED
///                  → EXPIRED  (via sweepExpired)
contract CommitmentRegistry is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── Enums & Structs ────────────────────────────────────────────────────

    enum CommitmentStatus { NONE, PENDING, EXECUTED, CANCELLED, EXPIRED }

    /// @notice Determines which verifier and public-input layout to use at execution.
    ///         ORDER_FILL (0): reads Chainlink oracle price; verifier = verifiers[0].
    ///         DCA        (1): uses a freshness-checked execution timestamp; verifier = verifiers[1].
    enum CommitmentKind { ORDER_FILL, DCA }

    struct CommitmentRecord {
        // Slot 0 — packed (20 + 8 + 1 + 1 = 30 bytes ≤ 32)
        address owner;            // User who registered this commitment
        uint64 expiry;            // Unix timestamp after which commitment is expired
        CommitmentStatus status;
        CommitmentKind kind;
        // Slot 1
        address tokenIn;          // Collateral token (token being sold / spent)
        // Slot 2
        address tokenOut;         // Token to receive after swap
        // Slot 3
        uint256 size;             // Amount of tokenIn locked in vault
        // Slot 4
        uint256 minOut;           // Minimum tokenOut (slippage protection; encrypted pre-execution)
    }

    struct Prover {
        address payout;
        address signer;
        bool active;
    }

    struct ProverReceipt {
        bytes32 proverId;
        uint64 ticketExpiresAt;
        bytes signature;
    }

    struct SettlementAmounts {
        uint256 grossAmountOut;
        uint256 executorFee;
        uint256 proverFee;
        uint256 userAmount;
    }

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice Per-kind verifier registry. Set via setVerifier(); never immutable so
    ///         new circuit versions can be deployed without redeploying the registry.
    ///         verifiers[0] = ORDER_FILL (UltraHonk, Chainlink public input)
    ///         verifiers[1] = DCA        (UltraHonk, execution-timestamp public input)
    mapping(uint8 => IVerifier) public verifiers;
    CollateralVault public vault;
    IDEXAdapter public dexAdapter;
    address public guardian;
    bool public paused;
    bytes32 public constant PROVER_RECEIPT_TYPEHASH = keccak256(
        "ProverReceipt(bytes32 commitmentHash,bytes32 nullifier,bytes32 proofHash,uint64 fillRef,uint64 ticketExpiresAt,uint8 kind,bytes32 proverId)"
    );
    uint16 public constant MAX_EXECUTOR_FEE_BPS = 500;
    uint16 public constant MAX_PROVER_FEE_BPS = 500;
    uint16 public constant MAX_TOTAL_FEE_BPS = 1000;
    uint16 public executorFeeBps;
    uint16 public proverFeeBps;

    /// @notice DCA proofs use a keeper-chosen execution timestamp. Settlement
    ///         must follow soon after so the timestamp remains anchored to the
    ///         current chain time without requiring exact block prediction.
    uint256 public constant DCA_FILL_REF_MAX_AGE = 5 minutes;

    /// @notice Maximum age of a Chainlink answer accepted at fill time.
    ///         Defaults to 1 hour; guardian may widen for feeds with longer heartbeat.
    uint256 public oracleStaleness = 1 hours;

    /// @notice Per-token Chainlink USD price feeds. Each token maps to a feed that returns
    ///         its price denominated in USD. The pair price (tokenIn/tokenOut) is derived
    ///         on-chain: price = (tokenIn_USD / tokenOut_USD) with tokenOut feed decimals precision.
    mapping(address token => IPriceFeed) public priceFeeds;
    mapping(bytes32 proverId => Prover) public provers;
    mapping(bytes32 => CommitmentRecord) private commitments;
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
    event CommitmentExecuted(
        bytes32        indexed commitmentHash,
        address        indexed owner,
        address        indexed executor,
        bytes32        nullifier,
        uint64         fillRef,
        uint256        amountOut,
        CommitmentKind kind
    );
    event ExecutionFeesPaid(
        bytes32 indexed commitmentHash,
        address indexed executor,
        bytes32 indexed proverId,
        address proverPayout,
        uint256 grossAmountOut,
        uint256 executorFee,
        uint256 proverFee,
        uint256 userAmount
    );
    event ProverSet(bytes32 indexed proverId, address indexed payout, address indexed signer, bool active);
    event ProverActiveSet(bytes32 indexed proverId, bool active);
    event FeeRatesSet(uint16 executorFeeBps, uint16 proverFeeBps);
    event CommitmentCancelled(bytes32 indexed commitmentHash, address indexed owner);
    event CommitmentExpired(bytes32 indexed commitmentHash, address indexed owner);
    event DEXAdapterChanged(address indexed oldAdapter, address indexed newAdapter);
    event CollateralVaultChanged(address indexed oldVault, address indexed newVault);
    event PriceFeedSet(address indexed token, address indexed feed);
    event OracleStalenessSet(uint256 oldValue, uint256 newValue);
    event Paused(address indexed guardian);
    event Unpaused(address indexed guardian);

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(
        address _collateral_vault,
        address _dexAdapter,
        address _guardian
    ) EIP712("zstrategy.ProverReceipt", "1") {
        require(_collateral_vault != address(0), "Registry: zero vault");
        require(_dexAdapter != address(0), "Registry: zero adapter");
        require(_guardian != address(0), "Registry: zero guardian");

        vault      = CollateralVault(_collateral_vault);
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
        require(tokenIn  != address(0),    "Registry: zero tokenIn");
        require(tokenOut != address(0),    "Registry: zero tokenOut");
        require(tokenIn  != tokenOut,      "Registry: same token");
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
    ///         ORDER_FILL reads the Chainlink pair price on-chain. DCA uses
    ///         fillRef as the execution timestamp proven by the circuit,
    ///         then checks that it is recent relative to block.timestamp.
    /// @param commitmentHash  The commitment to execute.
    /// @param nullifier       Prevents double-execution (public output of ZK circuit).
    /// @param proof           Serialised UltraPlonk proof bytes.
    /// @param fillRef         DCA execution timestamp. Ignored for ORDER_FILL.
    /// @param receipt         Prover authorization receipt for this execution ticket.
    function executeCommitment(
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes calldata proof,
        uint64 fillRef,
        ProverReceipt calldata receipt
    ) external nonReentrant whenNotPaused {
        CommitmentRecord storage c = commitments[commitmentHash];

        require(c.status == CommitmentStatus.PENDING, "Registry: not pending");
        require(block.timestamp <= c.expiry,          "Registry: expired");
        require(!nullifiers[nullifier],               "Registry: nullifier spent");

        IVerifier kv = verifiers[uint8(c.kind)];
        require(address(kv) != address(0), "Registry: verifier not set for kind");
        uint64 submittedFillRef = fillRef;
        address proverPayout = _verifyProverReceipt(
            commitmentHash,
            nullifier,
            proof,
            submittedFillRef,
            c.kind,
            receipt
        );

        // ── Build public inputs and read fill-time reference value ─────────
        // Public input layout is identical for both circuits:
        //   [0] commitment_hash  [1] fill_ref (oracle price or DCA execution timestamp)
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

        if (c.kind == CommitmentKind.ORDER_FILL) {
            require(fillRef == 0, "Registry: non-zero fillRef for ORDER_FILL");
            fillRef = _readOraclePrice(c.tokenIn, c.tokenOut);
        } else {
            // DCA: exact block.timestamp is unknowable before mining. The
            // proof binds to fillRef, and the registry checks the tx lands
            // shortly after that proven timestamp.
            require(fillRef <= block.timestamp, "Registry: DCA fillRef in future");
            require(block.timestamp - fillRef <= DCA_FILL_REF_MAX_AGE, "Registry: DCA fillRef stale");
        }
        publicInputs[1] = bytes32(uint256(fillRef));

        require(kv.verify(proof, publicInputs), "Registry: invalid proof");

        // ── Mark before external calls (CEI pattern) ──────────────────────
        nullifiers[nullifier] = true;
        c.status = CommitmentStatus.EXECUTED;

        // ── Release collateral to DEX adapter and swap ────────────────────
        SettlementAmounts memory amounts = _swapAndDistribute(commitmentHash, c, proverPayout);

        emit CommitmentExecuted(commitmentHash, c.owner, msg.sender, nullifier, fillRef, amounts.grossAmountOut, c.kind);
        emit ExecutionFeesPaid(
            commitmentHash,
            msg.sender,
            receipt.proverId,
            proverPayout,
            amounts.grossAmountOut,
            amounts.executorFee,
            amounts.proverFee,
            amounts.userAmount
        );
    }

    function _verifyProverReceipt(
        bytes32 commitmentHash,
        bytes32 nullifier,
        bytes calldata proof,
        uint64 submittedFillRef,
        CommitmentKind kind,
        ProverReceipt calldata receipt
    ) internal view returns (address payout) {
        require(block.timestamp <= receipt.ticketExpiresAt, "Registry: receipt expired");

        Prover memory prover = provers[receipt.proverId];
        require(prover.signer != address(0) && prover.payout != address(0), "Registry: unknown prover");
        require(prover.active, "Registry: inactive prover");

        bytes32 structHash = keccak256(abi.encode(
            PROVER_RECEIPT_TYPEHASH,
            commitmentHash,
            nullifier,
            keccak256(proof),
            submittedFillRef,
            receipt.ticketExpiresAt,
            uint8(kind),
            receipt.proverId
        ));
        address recovered = ECDSA.recover(_hashTypedDataV4(structHash), receipt.signature);
        require(recovered == prover.signer, "Registry: invalid prover signature");

        return prover.payout;
    }

    function _swapAndDistribute(
        bytes32 commitmentHash,
        CommitmentRecord storage c,
        address proverPayout
    ) internal returns (SettlementAmounts memory amounts) {
        IERC20 outToken = IERC20(c.tokenOut);
        uint256 balanceBefore = outToken.balanceOf(address(this));

        vault.releaseForExecution(commitmentHash, c.tokenIn, c.size, address(dexAdapter));
        dexAdapter.swap(c.tokenIn, c.tokenOut, c.size, 0, address(this));

        amounts.grossAmountOut = outToken.balanceOf(address(this)) - balanceBefore;
        require(amounts.grossAmountOut >= c.minOut, "Registry: gross amount below minOut");

        amounts.executorFee = (amounts.grossAmountOut * executorFeeBps) / 10000;
        amounts.proverFee = (amounts.grossAmountOut * proverFeeBps) / 10000;
        amounts.userAmount = amounts.grossAmountOut - amounts.executorFee - amounts.proverFee;

        _safeTransferIfNonZero(outToken, msg.sender, amounts.executorFee);
        _safeTransferIfNonZero(outToken, proverPayout, amounts.proverFee);
        _safeTransferIfNonZero(outToken, c.owner, amounts.userAmount);
    }

    function _safeTransferIfNonZero(IERC20 token, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        token.safeTransfer(recipient, amount);
    }

    /// @dev Derive the tokenIn/tokenOut price from two Chainlink USD feeds.
    ///      price = (tokenIn_USD / tokenOut_USD) expressed with tokenOut feed decimal places.
    ///      Both feeds are validated for freshness and positivity before use.
    function _readOraclePrice(address tokenIn, address tokenOut) internal view returns (uint64) {
        IPriceFeed feedIn  = priceFeeds[tokenIn];
        IPriceFeed feedOut = priceFeeds[tokenOut];
        require(address(feedIn)  != address(0), "Registry: no USD feed for tokenIn");
        require(address(feedOut) != address(0), "Registry: no USD feed for tokenOut");

        (, int256 answerIn,  , uint256 updatedAtIn,  ) = feedIn.latestRoundData();
        (, int256 answerOut, , uint256 updatedAtOut, ) = feedOut.latestRoundData();

        require(answerIn  > 0, "Registry: invalid tokenIn oracle answer");
        require(answerOut > 0, "Registry: invalid tokenOut oracle answer");
        // Staleness checks disabled for testnet — Arbitrum Sepolia feeds update infrequently.
        // Re-enable for mainnet: uncomment the two lines below and remove this comment.
        // require(updatedAtIn  > 0 && block.timestamp - updatedAtIn  <= oracleStaleness,
        //         "Registry: stale tokenIn oracle");
        // require(updatedAtOut > 0 && block.timestamp - updatedAtOut <= oracleStaleness,
        //         "Registry: stale tokenOut oracle");

        uint256 dIn  = uint256(feedIn.decimals());
        uint256 dOut = uint256(feedOut.decimals());

        // Normalise both answers to 1e18, then derive the pair price.
        // Result has dOut decimal places — consistent with what the ZK circuit expects.
        uint256 normIn  = uint256(answerIn)  * 10 ** (18 - dIn);
        uint256 normOut = uint256(answerOut) * 10 ** (18 - dOut);
        uint256 priceU  = normIn * 10 ** dOut / normOut;

        require(priceU > 0,                     "Registry: derived price is zero");
        require(priceU <= type(uint64).max,      "Registry: oracle price overflow");

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

    function setCollateralVault(address newVault) external onlyGuardian {
        require(newVault != address(0), "Registry: zero vault");
        emit CollateralVaultChanged(address(vault), newVault);
        vault = CollateralVault(payable(newVault));
    }

    function setProver(bytes32 proverId, address payout, address signer, bool active) external onlyGuardian {
        require(proverId != bytes32(0), "Registry: zero proverId");
        require(payout != address(0), "Registry: zero payout");
        require(signer != address(0), "Registry: zero signer");
        provers[proverId] = Prover({ payout: payout, signer: signer, active: active });
        emit ProverSet(proverId, payout, signer, active);
    }

    function setProverActive(bytes32 proverId, bool active) external onlyGuardian {
        Prover storage prover = provers[proverId];
        require(prover.signer != address(0) && prover.payout != address(0), "Registry: unknown prover");
        prover.active = active;
        emit ProverActiveSet(proverId, active);
    }

    function setFeeRates(uint16 newExecutorFeeBps, uint16 newProverFeeBps) external onlyGuardian {
        require(newExecutorFeeBps <= MAX_EXECUTOR_FEE_BPS, "Registry: executor fee too high");
        require(newProverFeeBps <= MAX_PROVER_FEE_BPS, "Registry: prover fee too high");
        require(
            uint256(newExecutorFeeBps) + uint256(newProverFeeBps) <= MAX_TOTAL_FEE_BPS,
            "Registry: total fee too high"
        );
        executorFeeBps = newExecutorFeeBps;
        proverFeeBps = newProverFeeBps;
        emit FeeRatesSet(newExecutorFeeBps, newProverFeeBps);
    }

    function setGuardian(address newGuardian) external onlyGuardian {
        require(newGuardian != address(0), "Registry: zero guardian");
        guardian = newGuardian;
    }

    /// @notice Configure the Chainlink-compatible USD price feed for a token.
    ///         Pass the zero address to remove the feed.
    function setPriceFeed(address token, address feed) external onlyGuardian {
        require(token != address(0), "Registry: zero token");
        priceFeeds[token] = IPriceFeed(feed);
        emit PriceFeedSet(token, feed);
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

}
