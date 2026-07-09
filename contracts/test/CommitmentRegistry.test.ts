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
} from "../typechain-types";

describe("CommitmentRegistry", () => {
  let guardian: SignerWithAddress;
  let user: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;
  let proverSigner: SignerWithAddress;
  let proverPayout: SignerWithAddress;

  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let verifier: MockZKVerifier;
  let dexAdapter: MockDEXAdapter;
  let feedIn:  MockChainlinkAggregator;
  let feedOut: MockChainlinkAggregator;
  let vault: CollateralVault;
  let registry: CommitmentRegistry;

  const SIZE    = ethers.parseUnits("100", 6);
  const MIN_OUT = ethers.parseUnits("0.03", 18);
  const DEX_OUT = ethers.parseUnits("0.033", 18);
  const PROOF   = "0x" + "ab".repeat(256);
  const FEED_DEC        = 8;
  const USDC_USD_ANSWER = 1_00000000n;
  const WETH_USD_ANSWER = 2900_00000000n;
  // Derived price = floor(normIn * 10^8 / normOut)
  //   normIn  = 1e8  * 1e10 = 1e18
  //   normOut = 2900e8 * 1e10 = 2.9e21
  //   price   = 1e26 / 2.9e21 = 34482
  const DERIVED_PRICE   = 34482n;
  const ORDER_FILL  = 0;
  const DCA         = 1;
  const PROVER_ID   = ethers.keccak256(ethers.toUtf8Bytes("simulated-nitro-local"));

  let commitmentHash: string;
  let nullifier: string;
  let expiry: number;

  async function deploy() {
    [guardian, user, keeper, other, proverSigner, proverPayout] = await ethers.getSigners();

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

    const VaultF = await ethers.getContractFactory("CollateralVault");
    vault = (await VaultF.deploy()) as unknown as CollateralVault;

    const RegistryF = await ethers.getContractFactory("CommitmentRegistry");
    registry = (await RegistryF.deploy(
      await vault.getAddress(),
      await dexAdapter.getAddress(),
      guardian.address
    )) as unknown as CommitmentRegistry;

    await vault.connect(guardian).setRegistry(await registry.getAddress());

    await registry.connect(guardian).setVerifier(ORDER_FILL, await verifier.getAddress());
    await registry.connect(guardian).setPriceFeed(await tokenIn.getAddress(),  await feedIn.getAddress());
    await registry.connect(guardian).setPriceFeed(await tokenOut.getAddress(), await feedOut.getAddress());
    await registry.connect(guardian).setProver(PROVER_ID, proverPayout.address, proverSigner.address, true);

    await tokenOut.mint(await dexAdapter.getAddress(), ethers.parseUnits("1000", 18));

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

  async function proverReceipt(
    hash: string,
    spentNullifier: string,
    proof = PROOF,
    fillRef: bigint | number = 0,
    kind = ORDER_FILL,
    ticketExpiresAt?: number,
    proverId = PROVER_ID,
    signer = proverSigner,
  ) {
    const expires = ticketExpiresAt ?? (await time.latest()) + 60;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const value = {
      commitmentHash: hash,
      nullifier: spentNullifier,
      proofHash: ethers.keccak256(proof),
      fillRef,
      ticketExpiresAt: expires,
      kind,
      proverId,
    };
    const signature = await signer.signTypedData(
      {
        name: "zstrategy.ProverReceipt",
        version: "1",
        chainId,
        verifyingContract: await registry.getAddress(),
      },
      {
        ProverReceipt: [
          { name: "commitmentHash", type: "bytes32" },
          { name: "nullifier", type: "bytes32" },
          { name: "proofHash", type: "bytes32" },
          { name: "fillRef", type: "uint64" },
          { name: "ticketExpiresAt", type: "uint64" },
          { name: "kind", type: "uint8" },
          { name: "proverId", type: "bytes32" },
        ],
      },
      value,
    );
    return { proverId, ticketExpiresAt: expires, signature };
  }

  async function execute(
    hash = commitmentHash,
    spentNullifier = nullifier,
    proof = PROOF,
    fillRef: bigint | number = 0,
    kind = ORDER_FILL,
    caller = keeper,
  ) {
    const receipt = await proverReceipt(hash, spentNullifier, proof, fillRef, kind);
    return registry.connect(caller).executeCommitment(hash, spentNullifier, proof, fillRef, receipt);
  }


  describe("registerCommitment", () => {
    it("stores commitment as PENDING", async () => {
      await registerOne();
      const record = await registry.getCommitment(commitmentHash);
      expect(record.owner).to.equal(user.address);
      expect(record.size).to.equal(SIZE);
      expect(record.status).to.equal(1);
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


  describe("executeCommitment", () => {
    beforeEach(async () => {
      await registerOne();
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
    });

    it("executes with valid proof and marks EXECUTED", async () => {
      await execute();
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(2);
    });

    it("emits CommitmentExecuted", async () => {
      await expect(
        execute()
      ).to.emit(registry, "CommitmentExecuted");
    });

    it("marks nullifier as spent", async () => {
      await execute();
      expect(await registry.nullifiers(nullifier)).to.be.true;
    });

    it("sends tokenOut to commitment owner", async () => {
      const before = await tokenOut.balanceOf(user.address);
      await execute();
      expect(await tokenOut.balanceOf(user.address)).to.equal(before + DEX_OUT);
    });

    it("splits output-token fees between executor, prover payout, and user", async () => {
      await registry.connect(guardian).setFeeRates(100, 200);

      const executorBefore = await tokenOut.balanceOf(keeper.address);
      const proverBefore = await tokenOut.balanceOf(proverPayout.address);
      const userBefore = await tokenOut.balanceOf(user.address);

      await execute();

      const executorFee = DEX_OUT * 100n / 10000n;
      const proverFee = DEX_OUT * 200n / 10000n;
      expect(await tokenOut.balanceOf(keeper.address)).to.equal(executorBefore + executorFee);
      expect(await tokenOut.balanceOf(proverPayout.address)).to.equal(proverBefore + proverFee);
      expect(await tokenOut.balanceOf(user.address)).to.equal(userBefore + DEX_OUT - executorFee - proverFee);
    });

    it("sends all gross output to the user when fee rates are zero", async () => {
      const userBefore = await tokenOut.balanceOf(user.address);
      await execute();
      expect(await tokenOut.balanceOf(user.address)).to.equal(userBefore + DEX_OUT);
      expect(await tokenOut.balanceOf(keeper.address)).to.equal(0);
      expect(await tokenOut.balanceOf(proverPayout.address)).to.equal(0);
    });

    it("allows executor and prover payout to receive both fees at the same address", async () => {
      await registry.connect(guardian).setProver(PROVER_ID, keeper.address, proverSigner.address, true);
      await registry.connect(guardian).setFeeRates(100, 200);

      const keeperBefore = await tokenOut.balanceOf(keeper.address);
      await execute();

      const executorFee = DEX_OUT * 100n / 10000n;
      const proverFee = DEX_OUT * 200n / 10000n;
      expect(await tokenOut.balanceOf(keeper.address)).to.equal(keeperBefore + executorFee + proverFee);
    });

    it("reverts when gross tokenOut is below minOut", async () => {
      await dexAdapter.setMockAmountOut(MIN_OUT - 1n);

      await expect(execute()).to.be.revertedWith("Registry: gross amount below minOut");
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(1);
      expect(await registry.nullifiers(nullifier)).to.be.false;
    });

    it("reverts on invalid proof", async () => {
      await verifier.setShouldPass(false);
      await expect(
        execute()
      ).to.be.revertedWith("Registry: invalid proof");
    });

    it("reverts for unknown prover receipts", async () => {
      const unknownProverId = ethers.keccak256(ethers.toUtf8Bytes("unknown-prover"));
      const receipt = await proverReceipt(
        commitmentHash,
        nullifier,
        PROOF,
        0,
        ORDER_FILL,
        undefined,
        unknownProverId,
      );

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: unknown prover");
    });

    it("reverts for inactive prover receipts", async () => {
      await registry.connect(guardian).setProverActive(PROVER_ID, false);

      await expect(execute()).to.be.revertedWith("Registry: inactive prover");
    });

    it("reverts for expired prover receipts", async () => {
      const receipt = await proverReceipt(
        commitmentHash,
        nullifier,
        PROOF,
        0,
        ORDER_FILL,
        (await time.latest()) - 1,
      );

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: receipt expired");
    });

    it("reverts for receipts signed by the wrong signer", async () => {
      const receipt = await proverReceipt(
        commitmentHash,
        nullifier,
        PROOF,
        0,
        ORDER_FILL,
        undefined,
        PROVER_ID,
        other,
      );

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("reverts when the signed fillRef field is tampered", async () => {
      const receipt = await proverReceipt(commitmentHash, nullifier, PROOF, 1, ORDER_FILL);

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("reverts when the signed proof hash is tampered", async () => {
      const receipt = await proverReceipt(commitmentHash, nullifier, PROOF, 0, ORDER_FILL);
      const otherProof = "0x" + "cd".repeat(256);

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, otherProof, 0, receipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("reverts when the signed nullifier field is tampered", async () => {
      const receipt = await proverReceipt(commitmentHash, nullifier, PROOF, 0, ORDER_FILL);
      const otherNullifier = ethers.keccak256(ethers.toUtf8Bytes("other-nullifier"));

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, otherNullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("reverts when the signed commitment kind is tampered", async () => {
      const receipt = await proverReceipt(commitmentHash, nullifier, PROOF, 0, DCA);

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, receipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("reverts when the signed proverId field is tampered", async () => {
      const otherProverId = ethers.keccak256(ethers.toUtf8Bytes("other-prover"));
      await registry.connect(guardian).setProver(otherProverId, proverPayout.address, proverSigner.address, true);
      const receipt = await proverReceipt(commitmentHash, nullifier, PROOF, 0, ORDER_FILL);
      const tamperedReceipt = { ...receipt, proverId: otherProverId };

      await expect(
        registry.connect(keeper).executeCommitment(commitmentHash, nullifier, PROOF, 0, tamperedReceipt)
      ).to.be.revertedWith("Registry: invalid prover signature");
    });

    it("rolls back status, nullifier, and collateral when the DEX fill fails", async () => {
      await dexAdapter.setMockAmountOut(0);

      await expect(
        execute()
      ).to.be.revertedWith("MockDEX: swap disabled");

      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(1);
      expect(await registry.nullifiers(nullifier)).to.be.false;
      expect(await vault.lockedBalance(commitmentHash, await tokenIn.getAddress())).to.equal(SIZE);
    });

    it("rolls back output transfer when the DEX reverts after partial progress", async () => {
      const userTokenOutBefore = await tokenOut.balanceOf(user.address);
      const adapterTokenInBefore = await tokenIn.balanceOf(await dexAdapter.getAddress());
      await (dexAdapter as any).setRevertAfterTransfer(true);

      await expect(
        execute()
      ).to.be.revertedWith("MockDEX: post-transfer failure");

      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(1);
      expect(await registry.nullifiers(nullifier)).to.be.false;
      expect(await vault.lockedBalance(commitmentHash, await tokenIn.getAddress())).to.equal(SIZE);
      expect(await tokenOut.balanceOf(user.address)).to.equal(userTokenOutBefore);
      expect(await tokenIn.balanceOf(await dexAdapter.getAddress())).to.equal(adapterTokenInBefore);
    });

    it("reverts on spent nullifier", async () => {
      await execute();

      const h2 = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h2, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
      );
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);

      await expect(
        execute(h2, nullifier)
      ).to.be.revertedWith("Registry: nullifier spent");
    });

    it("reverts on expired commitment", async () => {
      await time.increaseTo(expiry + 1);
      await expect(
        execute()
      ).to.be.revertedWith("Registry: expired");
    });

    it("reverts when paused", async () => {
      await registry.connect(guardian).pause();
      await expect(
        execute()
      ).to.be.revertedWith("Registry: paused");
    });

    it("reverts on double-execute", async () => {
      await execute();
      const n2 = ethers.keccak256(ethers.toUtf8Bytes("nullifier-2"));
      await expect(
        execute(commitmentHash, n2)
      ).to.be.revertedWith("Registry: not pending");
    });

    it("self-execution: user can execute without keeper", async () => {
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
      await expect(
        execute(commitmentHash, nullifier, PROOF, 0, ORDER_FILL, user)
      ).to.emit(registry, "CommitmentExecuted");
    });

    it("emits the derived oracle price in CommitmentExecuted", async () => {
      await expect(
        execute()
      ).to.emit(registry, "CommitmentExecuted")
       .withArgs(commitmentHash, user.address, keeper.address, nullifier, DERIVED_PRICE, DEX_OUT, ORDER_FILL);
    });

    it("audit-logs the executor address in CommitmentExecuted", async () => {
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);
      await expect(
        execute(commitmentHash, nullifier, PROOF, 0, ORDER_FILL, user)
      ).to.emit(registry, "CommitmentExecuted")
       .withArgs(commitmentHash, user.address, user.address, nullifier, DERIVED_PRICE, DEX_OUT, ORDER_FILL);
    });

    it("reverts when no USD feed is configured for tokenIn", async () => {
      await registry.connect(guardian).setPriceFeed(await tokenIn.getAddress(), ethers.ZeroAddress);
      await expect(
        execute()
      ).to.be.revertedWith("Registry: no USD feed for tokenIn");
    });

    it("reverts on non-positive tokenIn oracle answer", async () => {
      await feedIn.setAnswer(0);
      await expect(
        execute()
      ).to.be.revertedWith("Registry: invalid tokenIn oracle answer");
    });

    it("reverts on oracle answer that overflows uint64", async () => {
      // Set feedOut to $1 so derived price == feedIn.answer; then feedIn = 2^64 overflows uint64.
      await feedOut.setAnswer(100000000n);
      await feedIn.setAnswer(BigInt("18446744073709551616"));
      await expect(
        execute()
      ).to.be.revertedWith("Registry: oracle price overflow");
    });

    it("uses the caller-provided recent fillRef for DCA", async () => {
      const h = ethers.keccak256(ethers.toUtf8Bytes("dca-commitment"));
      const n = ethers.keccak256(ethers.toUtf8Bytes("dca-nullifier"));
      await registry.connect(guardian).setVerifier(DCA, await verifier.getAddress());
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, DCA
      );
      await tokenIn.mint(await dexAdapter.getAddress(), SIZE);

      const fillRef = await time.latest();
      await expect(
        execute(h, n, PROOF, fillRef, DCA)
      ).to.emit(registry, "CommitmentExecuted")
       .withArgs(h, user.address, keeper.address, n, fillRef, DEX_OUT, DCA);
    });

    it("rejects a DCA fillRef from the future", async () => {
      const h = ethers.keccak256(ethers.toUtf8Bytes("dca-future"));
      const n = ethers.keccak256(ethers.toUtf8Bytes("dca-future-nullifier"));
      await registry.connect(guardian).setVerifier(DCA, await verifier.getAddress());
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, DCA
      );

      await expect(
        execute(h, n, PROOF, (await time.latest()) + 60, DCA)
      ).to.be.revertedWith("Registry: DCA fillRef in future");
    });

    it("rejects a stale DCA fillRef", async () => {
      const h = ethers.keccak256(ethers.toUtf8Bytes("dca-stale"));
      const n = ethers.keccak256(ethers.toUtf8Bytes("dca-stale-nullifier"));
      await registry.connect(guardian).setVerifier(DCA, await verifier.getAddress());
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, DCA
      );

      await expect(
        execute(h, n, PROOF, (await time.latest()) - 301, DCA)
      ).to.be.revertedWith("Registry: DCA fillRef stale");
    });
  });


  describe("cancelCommitment", () => {
    beforeEach(registerOne);

    it("cancels and returns collateral to free balance", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(3);
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


  describe("sweepExpired", () => {
    beforeEach(registerOne);

    it("expires commitment and returns collateral", async () => {
      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash]);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(4);
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
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(1);
    });

    it("silently skips already-cancelled commitments", async () => {
      await registry.connect(user).cancelCommitment(commitmentHash, nullifier);
      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash]);
      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(3);
    });

    it("can sweep multiple in one call", async () => {
      const h2 = ethers.keccak256(ethers.toUtf8Bytes("commitment-2"));
      await vault.connect(user).deposit(await tokenIn.getAddress(), SIZE);
      await registry.connect(user).registerCommitment(
        h2, await tokenIn.getAddress(), await tokenOut.getAddress(), SIZE, MIN_OUT, expiry, ORDER_FILL
      );

      await time.increaseTo(expiry + 1);
      await registry.connect(other).sweepExpired([commitmentHash, h2]);

      expect(await registry.getCommitmentStatus(commitmentHash)).to.equal(4);
      expect(await registry.getCommitmentStatus(h2)).to.equal(4);
    });
  });


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
        expect(await registry.getCommitmentStatus(h)).to.equal(1);
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
          [SIZE, SIZE],
          [MIN_OUT],
          [expiry],
          ORDER_FILL
        )
      ).to.be.revertedWith("Registry: sizes length mismatch");
    });
  });

  describe("Prover & FeeRates setting", () => {
    it("guardian can update prover payout, signer, and active status", async () => {
      const nextProverId = ethers.keccak256(ethers.toUtf8Bytes("next-prover"));

      await expect(
        registry.connect(guardian).setProver(nextProverId, user.address, other.address, true)
      ).to.emit(registry, "ProverSet")
       .withArgs(nextProverId, user.address, other.address, true);

      const prover = await registry.provers(nextProverId);
      expect(prover.payout).to.equal(user.address);
      expect(prover.signer).to.equal(other.address);
      expect(prover.active).to.equal(true);
    });

    it("non-guardian cannot update prover settings or fee rates", async () => {
      await expect(
        registry.connect(other).setProver(PROVER_ID, user.address, other.address, true)
      ).to.be.revertedWith("Registry: caller not guardian");
      await expect(
        registry.connect(other).setFeeRates(100, 100)
      ).to.be.revertedWith("Registry: caller not guardian");
    });

    it("enforces executor and prover fee caps", async () => {
      await expect(
        registry.connect(guardian).setFeeRates(501, 0)
      ).to.be.revertedWith("Registry: executor fee too high");
      await expect(
        registry.connect(guardian).setFeeRates(0, 501)
      ).to.be.revertedWith("Registry: prover fee too high");
    });
  });
});
