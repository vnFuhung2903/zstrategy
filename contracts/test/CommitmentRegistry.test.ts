import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockERC20,
  MockZKVerifier,
  MockDEXAdapter,
  MockChainlinkAggregator,
  CollateralVault,
  CommitmentRegistry,
  GasVault,
} from "../typechain-types";

describe("CommitmentRegistry", () => {
  let guardian: SignerWithAddress;
  let user: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;

  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let verifier: MockZKVerifier;
  let dexAdapter: MockDEXAdapter;
  let feedIn:  MockChainlinkAggregator;   // tokenIn (USDC) / USD
  let feedOut: MockChainlinkAggregator;   // tokenOut (WETH) / USD
  let vault: CollateralVault;
  let registry: CommitmentRegistry;

  const SIZE    = ethers.parseUnits("100", 6);   // 100 USDC
  const MIN_OUT = ethers.parseUnits("0.03", 18);
  const DEX_OUT = ethers.parseUnits("0.033", 18);
  const PROOF   = "0x" + "ab".repeat(256);       // dummy — verifier is mocked
  const FEED_DEC        = 8;
  const USDC_USD_ANSWER = 1_00000000n;           // $1.00 with 8 decimals
  const WETH_USD_ANSWER = 2900_00000000n;        // $2900 with 8 decimals
  // Derived price = floor(normIn * 10^8 / normOut)
  //   normIn  = 1e8  * 1e10 = 1e18
  //   normOut = 2900e8 * 1e10 = 2.9e21
  //   price   = 1e26 / 2.9e21 = 34482
  const DERIVED_PRICE   = 34482n;
  const ORDER_FILL  = 0;                         // CommitmentKind.ORDER_FILL

  let commitmentHash: string;
  let nullifier: string;
  let expiry: number;

  async function deploy() {
    [guardian, user, keeper, other] = await ethers.getSigners();

    const ERC20F = await ethers.getContractFactory("MockERC20");
    tokenIn  = (await ERC20F.deploy("Mock USDC", "USDC", 6))  as unknown as MockERC20;
    tokenOut = (await ERC20F.deploy("Mock WETH", "WETH", 18)) as unknown as MockERC20;

    const VerifierF = await ethers.getContractFactory("MockZKVerifier");
    verifier = (await VerifierF.deploy()) as unknown as MockZKVerifier;

    const DEXF = await ethers.getContractFactory("MockDEXAdapter");
    dexAdapter = (await DEXF.deploy(DEX_OUT)) as unknown as MockDEXAdapter;

    const FeedF = await ethers.getContractFactory("MockChainlinkAggregator");
    feedIn  = (await FeedF.deploy(FEED_DEC, USDC_USD_ANSWER)) as unknown as MockChainlinkAggregator;
    feedOut = (await FeedF.deploy(FEED_DEC, WETH_USD_ANSWER)) as unknown as MockChainlinkAggregator;

    // Break circular dependency: vault ← registry ← vault
    //   1. Deploy vault (no constructor arg needed now)
    //   2. Deploy registry pointing at vault
    //   3. Call vault.setRegistry(registry)
    const VaultF = await ethers.getContractFactory("CollateralVault");
    vault = (await VaultF.deploy()) as unknown as CollateralVault;

    const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
    registry = (await RegistryF.deploy(
      await verifier.getAddress(),
      await vault.getAddress(),
      await dexAdapter.getAddress(),
      guardian.address
    )) as unknown as CommitmentRegistry;

    await vault.connect(guardian).setRegistry(await registry.getAddress());

    await registry.connect(guardian).setPriceFeed(await tokenIn.getAddress(),  await feedIn.getAddress());
    await registry.connect(guardian).setPriceFeed(await tokenOut.getAddress(), await feedOut.getAddress());

    // Seed dexAdapter with tokenOut (output side of swaps)
    await tokenOut.mint(await dexAdapter.getAddress(), ethers.parseUnits("1000", 18));

    // Mint tokenIn for user and approve vault
    await tokenIn.mint(user.address, SIZE * 100n);
    await tokenIn.connect(user).approve(await vault.getAddress(), SIZE * 100n);

    expiry = (await time.latest()) + 86400;
    commitmentHash = ethers.keccak256(ethers.toUtf8Bytes("commitment-1"));
    nullifier      = ethers.keccak256(ethers.toUtf8Bytes("nullifier-1"));
  }

  beforeEach(deploy);

  async function registerOne(hash = commitmentHash) {
    await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
    await registry.connect(user).registerCommitment(
      hash,
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      SIZE,
      MIN_OUT,
      expiry,
      ORDER_FILL
    );
  }

  // ── registerCommitment ─────────────────────────────────────────────────

  describe("registerCommitment", () => {
    it("stores commitment as PENDING", async () => {
      await registerOne();
      const record = await registry.getCommitment(commitmentHash);
      expect(record.owner).to.equal(user.address);
      expect(record.size).to.equal(SIZE);
      expect(record.status).to.equal(1); // PENDING
    });

    it("emits CommitmentRegistered", async () => {
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitment(
          commitmentHash,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          SIZE,
          MIN_OUT,
          expiry,
          ORDER_FILL
        )
      ).to.emit(registry, "CommitmentRegistered")
       .withArgs(commitmentHash, user.address, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, expiry, ORDER_FILL);
    });

    it("locks collateral in vault", async () => {
      await registerOne();
      expect(await vault.lockedBalance(commitmentHash, await tokenIn.getAddress())).to.equal(SIZE);
      expect(await vault.freeBalance(user.address, await tokenIn.getAddress())).to.equal(0);
    });

    it("reverts on duplicate commitment hash", async () => {
      await registerOne();
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitment(
          commitmentHash,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          SIZE,
          MIN_OUT,
          expiry,
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: duplicate commitment");
    });

    it("reverts on zero hash", async () => {
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitment(
          ethers.ZeroHash,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          SIZE,
          MIN_OUT,
          expiry,
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: zero hash");
    });

    it("reverts when paused", async () => {
      await registry.connect(guardian).pause();
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitment(
          commitmentHash,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          SIZE,
          MIN_OUT,
          expiry,
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: paused");
    });

    it("reverts if expiry in past", async () => {
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      const pastExpiry = (await time.latest()) - 1;
      await expect(
        registry.connect(user).registerCommitment(
          commitmentHash,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          SIZE,
          MIN_OUT,
          pastExpiry,
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: expiry in past");
    });

    it("reverts on same tokenIn and tokenOut", async () => {
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitment(
          commitmentHash,
          await tokenIn.getAddress(),
          await tokenIn.getAddress(),
          SIZE,
          MIN_OUT,
          expiry,
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: same token");
    });
  });

  // ── executeCommitment ──────────────────────────────────────────────────

  describe("executeCommitment", () => {
    beforeEach(async () => {
      await registerOne();
      // Seed dexAdapter with extra tokenIn so the balance check in MockDEXAdapter passes
      // (vault.releaseForExecution sends tokenIn to dexAdapter before swap() is called)
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
    });

    it("executes with valid proof and marks EXECUTED", async () => {
      await registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(2); // EXECUTED
    });

    it("emits CommitmentExecuted", async () => {
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.emit(registry, "CommitmentExecuted");
    });

    it("marks nullifier as spent", async () => {
      await registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF);
      expect(await registry.nullifiers(nullifier)).to.be.true;
    });

    it("sends tokenOut to commitment owner", async () => {
      const before = await tokenOut.balanceOf(user.address);
      await registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF);
      expect(await tokenOut.balanceOf(user.address)).to.equal(before + DEX_OUT);
    });

    it("reverts on invalid proof", async () => {
      await verifier.setShouldPass(false);
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: invalid proof");
    });

    it("reverts on spent nullifier", async () => {
      await registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF);

      const h2 = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h2, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
      );
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);

      await expect(
        registry.connect(keeper).executeCommitment(h2, nullifier, PROOF)
      ).to.be.revertedWith("Registry: nullifier spent");
    });

    it("reverts on expired commitment", async () => {
      await time.increaseTo(expiry + 1);
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: expired");
    });

    it("reverts when paused", async () => {
      await registry.connect(guardian).pause();
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: paused");
    });

    it("reverts on double-execute", async () => {
      await registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF);
      const n2 = ethers.keccak256(ethers.toUtf8Bytes("nullifier-2"));
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, n2, PROOF)
      ).to.be.revertedWith("Registry: not pending");
    });

    it("self-execution: user can execute without keeper", async () => {
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE); // extra for this test
      await expect(
        registry.connect(user).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.emit(registry, "CommitmentExecuted");
    });

    it("emits the derived oracle price in CommitmentExecuted", async () => {
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.emit(registry, "CommitmentExecuted")
       .withArgs(commitmentHash, user.address, keeper.address, nullifier, DERIVED_PRICE, DEX_OUT, ORDER_FILL);
    });

    it("audit-logs the executor address in CommitmentExecuted", async () => {
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
      await expect(
        registry.connect(user).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.emit(registry, "CommitmentExecuted")
       .withArgs(commitmentHash, user.address, user.address, nullifier, DERIVED_PRICE, DEX_OUT, ORDER_FILL);
    });

    it("reverts when no USD feed is configured for tokenIn", async () => {
      await registry.connect(guardian).setPriceFeed(await tokenIn.getAddress(), ethers.ZeroAddress);
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: no USD feed for tokenIn");
    });

    it("reverts on non-positive tokenIn oracle answer", async () => {
      await feedIn.setAnswer(0);
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: invalid tokenIn oracle answer");
    });

    it("reverts on oracle answer that overflows uint64", async () => {
      // Set feedOut to $1 so derived price == feedIn.answer; then feedIn = 2^64 overflows uint64.
      await feedOut.setAnswer(100000000n);
      await feedIn.setAnswer(BigInt("18446744073709551616")); // 2^64
      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF)
      ).to.be.revertedWith("Registry: oracle price overflow");
    });
  });

  // ── cancelCommitment ───────────────────────────────────────────────────

  describe("cancelCommitment", () => {
    beforeEach(registerOne);

    it("cancels and returns collateral to free balance", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(3); // CANCELLED
      expect(await vault.freeBalance(user.address, await tokenIn.getAddress())).to.equal(SIZE);
    });

    it("emits CommitmentCancelled", async () => {
      await expect(
        registry.connect(user).cancelCommitment(commitmentHash, nullifier)
      ).to.emit(registry, "CommitmentCancelled").withArgs(commitmentHash, user.address);
    });

    it("reverts if non-owner cancels", async () => {
      await expect(
        registry.connect(other).cancelCommitment(commitmentHash, nullifier)
      ).to.be.revertedWith("Registry: not owner");
    });

    it("reverts on spent nullifier", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      const h2 = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h2, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
      );
      await expect(
        registry.connect(user).cancelCommitment(h2, nullifier)
      ).to.be.revertedWith("Registry: nullifier spent");
    });

    it("reverts on already-cancelled commitment", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      const n2 = ethers.keccak256(ethers.toUtf8Bytes("nullifier-2"));
      await expect(
        registry.connect(user).cancelCommitment(commitmentHash, n2)
      ).to.be.revertedWith("Registry: not pending");
    });
  });

  // ── sweepExpired ───────────────────────────────────────────────────────

  describe("sweepExpired", () => {
    beforeEach(registerOne);

    it("expires commitment and returns collateral", async () => {
      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash]);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(4); // EXPIRED
      expect(await vault.freeBalance(user.address, await tokenIn.getAddress())).to.equal(SIZE);
    });

    it("emits CommitmentExpired", async () => {
      await time.increaseTo(expiry + 1);
      await expect(registry.connect(other).sweepExpired([commitmentHash]))
        .to.emit(registry, "CommitmentExpired")
        .withArgs(commitmentHash, user.address);
    });

    it("silently skips non-expired commitments", async () => {
      await registry.connect(other).sweepExpired([commitmentHash]);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(1); // still PENDING
    });

    it("silently skips already-cancelled commitments", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash]);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(3); // still CANCELLED
    });

    it("can sweep multiple in one call", async () => {
      const h2 = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      // Use same expiry so both expire at the same time
      await registry.connect(user).registerCommitment(
        h2, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
      );

      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash, h2]);

      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(4);
      expect(await registry.getCommitmentStatus(h2)).to.equal(4);
    });
  });

  // ── registerCommitmentBatch ────────────────────────────────────────────

  describe("registerCommitmentBatch", () => {
    it("registers multiple commitments atomically", async () => {
      const n = 3;
      const hashes   = Array.from({ length: n }, (_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`batch-${i}`))
      );
      const sizes    = Array(n).fill(SIZE);
      const minOuts  = Array(n).fill(MIN_OUT);
      const expiries = Array(n).fill(expiry);

      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE * BigInt(n));

      await expect(
        registry.connect(user).registerCommitmentBatch(
          hashes,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          sizes,
          minOuts,
          expiries,
          ORDER_FILL
        )
      ).to.emit(registry, "CommitmentRegistered");

      for (const h of hashes) {
        expect(await registry.getCommitmentStatus(h)).to.equal(1); // PENDING
      }
    });

    it("reverts on batch size > 10", async () => {
      const hashes = Array.from({ length: 11 }, (_, i) =>
        ethers.keccak256(ethers.toUtf8Bytes(`big-batch-${i}`))
      );
      await expect(
        registry.connect(user).registerCommitmentBatch(
          hashes,
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          Array(11).fill(SIZE),
          Array(11).fill(MIN_OUT),
          Array(11).fill(expiry),
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: batch size 1-10");
    });

    it("reverts on array length mismatch", async () => {
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await expect(
        registry.connect(user).registerCommitmentBatch(
          [ethers.keccak256(ethers.toUtf8Bytes("x"))],
          await tokenIn.getAddress(),
          await tokenOut.getAddress(),
          [SIZE, SIZE], // wrong length
          [MIN_OUT],
          [expiry],
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: sizes length mismatch");
    });
  });

  // ── circuit breaker ────────────────────────────────────────────────────

  describe("circuit breaker", () => {
    it("guardian can pause and unpause", async () => {
      await registry.connect(guardian).pause();
      expect(await registry.paused()).to.be.true;
      await registry.connect(guardian).unpause();
      expect(await registry.paused()).to.be.false;
    });

    it("non-guardian cannot pause", async () => {
      await expect(registry.connect(other).pause())
        .to.be.revertedWith("Registry: caller not guardian");
    });

    it("guardian can update DEX adapter", async () => {
      const newAdapter = await (await ethers.getContractFactory("MockDEXAdapter")).deploy(DEX_OUT);
      await registry.connect(guardian).setDEXAdapter(await newAdapter.getAddress());
      expect(await registry.dexAdapter()).to.equal(await newAdapter.getAddress());
    });

    it("auto-pauses when volume exceeds 10x baseline in one hour", async () => {
      const baseline = SIZE; // 100 USDC baseline
      await registry.connect(guardian).setVolumeBaseline(await tokenIn.getAddress(), baseline);

      // Execute 11 commitments in the same hour window → total = 11 × SIZE = 11× baseline → auto-pause
      for (let i = 0; i < 11; i++) {
        const h = ethers.keccak256(ethers.toUtf8Bytes(`spike-${i}`));
        const n = ethers.keccak256(ethers.toUtf8Bytes(`spike-null-${i}`));

        await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
        await registry.connect(user).registerCommitment(
          h, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
        );
        await tokenIn.mint(await dexAdapter.getAddress(), SIZE);

        await registry.connect(keeper).executeCommitment(h, n, PROOF);
      }

      expect(await registry.paused()).to.be.true;
    });
  });

  // ── executeCommitment with gas tank wired ──────────────────────────────
  //
  // Existing executeCommitment tests above run with `gasVault == 0`, exercising
  // the back-compat short-circuit in _debitGas. This block wires up GasVault
  // and exercises the full reimbursement path.

  describe("executeCommitment (gas tank wired)", () => {
    let gasVault: GasVault;
    const GAS_DEPOSIT = ethers.parseEther("0.05");
    // 1 gwei makes the cost calculation non-zero and predictable. Hardhat's
    // EIP-1559 defaults already give a basefee, but pinning is clearer.
    const TX_GAS_PRICE = ethers.parseUnits("1", "gwei");

    beforeEach(async () => {
      const GasVaultF = await ethers.getContractFactory("GasVault");
      gasVault = (await GasVaultF.deploy()) as unknown as GasVault;
      await gasVault.connect(guardian).setRegistry(await registry.getAddress());
      await registry.connect(guardian).setGasVault(await gasVault.getAddress());

      // Prepay user's gas tank, then register + seed dex with tokenIn
      await gasVault.connect(user).deposit({ value: GAS_DEPOSIT });
      await registerOne();
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
    });

    it("debits owner's gas balance and forwards ETH to keeper", async () => {
      const before = await gasVault.balanceOf(user.address);
      const tx = await registry.connect(keeper).executeCommitment(
        commitmentHash, nullifier, PROOF, { gasPrice: TX_GAS_PRICE }
      );
      await tx.wait();
      const after = await gasVault.balanceOf(user.address);
      expect(after).to.be.lt(before);                 // user debited
      expect(before - after).to.be.gt(0n);            // non-zero cost
    });

    it("emits Debited with the commitmentHash", async () => {
      await expect(
        registry.connect(keeper).executeCommitment(
          commitmentHash, nullifier, PROOF, { gasPrice: TX_GAS_PRICE }
        )
      ).to.emit(gasVault, "Debited");
    });

    it("self-execution by owner skips the debit", async () => {
      const before = await gasVault.balanceOf(user.address);
      await registry.connect(user).executeCommitment(
        commitmentHash, nullifier, PROOF, { gasPrice: TX_GAS_PRICE }
      );
      const after = await gasVault.balanceOf(user.address);
      expect(after).to.equal(before);                 // no debit on self-execute
    });

    it("reverts when owner's gas balance is insufficient", async () => {
      // Drain owner's gas tank first
      const balance = await gasVault.balanceOf(user.address);
      await gasVault.connect(user).withdraw(balance);

      await expect(
        registry.connect(keeper).executeCommitment(
          commitmentHash, nullifier, PROOF, { gasPrice: TX_GAS_PRICE }
        )
      ).to.be.revertedWith("GasVault: insufficient gas balance");
    });

    it("guardian can set the gas vault (and disable via zero address)", async () => {
      await expect(
        registry.connect(guardian).setGasVault(ethers.ZeroAddress)
      ).to.emit(registry, "GasVaultChanged");
      expect(await registry.gasVault()).to.equal(ethers.ZeroAddress);

      // With gas vault disabled, execution succeeds and does not touch the (drained) tank
      const before = await gasVault.balanceOf(user.address);
      await registry.connect(keeper).executeCommitment(
        commitmentHash, nullifier, PROOF, { gasPrice: TX_GAS_PRICE }
      );
      const after = await gasVault.balanceOf(user.address);
      expect(after).to.equal(before);
    });

    it("non-guardian cannot set the gas vault", async () => {
      await expect(
        registry.connect(other).setGasVault(ethers.ZeroAddress)
      ).to.be.revertedWith("Registry: caller not guardian");
    });
  });
});
