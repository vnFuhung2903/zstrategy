import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockERC20,
  CollateralVault,
} from "../typechain-types";

describe("CollateralVault", () => {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let registry: SignerWithAddress;
  let other: SignerWithAddress;

  let token: MockERC20;
  let vault: CollateralVault;

  const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 6); // 1000 USDC
  const COMMITMENT = ethers.keccak256(ethers.toUtf8Bytes("commitment-1"));

  beforeEach(async () => {
    [owner, user, registry, other] = await ethers.getSigners();

    const ERC20F = await ethers.getContractFactory("MockERC20");
    token = (await ERC20F.deploy("Mock USDC", "USDC", 6)) as unknown as MockERC20;

    const VaultF = await ethers.getContractFactory("CollateralVault");
    vault = (await VaultF.deploy()) as unknown as CollateralVault;
    await vault.connect(owner).setRegistry(registry.address);

    // Mint and pre-approve for user
    await token.mint(user.address, DEPOSIT_AMOUNT * 10n);
    await token.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT * 10n);
  });

  // ── deposit ────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("increases freeBalance and emits Deposited", async () => {
      await expect(vault.connect(user).deposit(await token.getAddress(), DEPOSIT_AMOUNT))
        .to.emit(vault, "Deposited")
        .withArgs(user.address, await token.getAddress(), DEPOSIT_AMOUNT);

      expect(await vault.freeBalance(user.address, await token.getAddress()))
        .to.equal(DEPOSIT_AMOUNT);
    });

    it("reverts on zero amount", async () => {
      await expect(vault.connect(user).deposit(await token.getAddress(), 0))
        .to.be.revertedWith("Vault: zero amount");
    });

    it("reverts if allowance insufficient", async () => {
      const freshToken = (await (await ethers.getContractFactory("MockERC20")).deploy("T", "T", 18)) as unknown as MockERC20;
      await freshToken.mint(user.address, DEPOSIT_AMOUNT);
      // no approval
      await expect(vault.connect(user).deposit(await freshToken.getAddress(), DEPOSIT_AMOUNT))
        .to.be.reverted;
    });
  });

  // ── withdraw ───────────────────────────────────────────────────────────

  describe("withdraw", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("decreases freeBalance and transfers tokens", async () => {
      const before = await token.balanceOf(user.address);
      await vault.connect(user).withdraw(await token.getAddress(), DEPOSIT_AMOUNT);
      expect(await token.balanceOf(user.address)).to.equal(before + DEPOSIT_AMOUNT);
      expect(await vault.freeBalance(user.address, await token.getAddress())).to.equal(0);
    });

    it("reverts if withdrawal exceeds free balance", async () => {
      await expect(vault.connect(user).withdraw(await token.getAddress(), DEPOSIT_AMOUNT + 1n))
        .to.be.revertedWith("Vault: insufficient free balance");
    });
  });

  // ── lockCollateral ─────────────────────────────────────────────────────

  describe("lockCollateral", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("moves funds from free to locked", async () => {
      await vault.connect(registry).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT);

      expect(await vault.freeBalance(user.address, await token.getAddress())).to.equal(0);
      expect(await vault.lockedBalance(COMMITMENT, await token.getAddress())).to.equal(DEPOSIT_AMOUNT);
    });

    it("emits CollateralLocked", async () => {
      await expect(
        vault.connect(registry).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT)
      ).to.emit(vault, "CollateralLocked").withArgs(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("reverts if non-registry calls", async () => {
      await expect(
        vault.connect(other).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT)
      ).to.be.revertedWith("Vault: caller not registry");
    });

    it("reverts if insufficient free balance", async () => {
      await expect(
        vault.connect(registry).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT + 1n)
      ).to.be.revertedWith("Vault: insufficient free balance");
    });
  });

  // ── releaseForExecution ────────────────────────────────────────────────

  describe("releaseForExecution", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(registry).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("transfers locked tokens to recipient", async () => {
      const before = await token.balanceOf(other.address);
      await vault.connect(registry).releaseForExecution(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT, other.address);
      expect(await token.balanceOf(other.address)).to.equal(before + DEPOSIT_AMOUNT);
      expect(await vault.lockedBalance(COMMITMENT, await token.getAddress())).to.equal(0);
    });

    it("emits CollateralReleased", async () => {
      await expect(
        vault.connect(registry).releaseForExecution(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT, other.address)
      ).to.emit(vault, "CollateralReleased").withArgs(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT, other.address);
    });

    it("reverts if non-registry calls", async () => {
      await expect(
        vault.connect(other).releaseForExecution(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT, other.address)
      ).to.be.revertedWith("Vault: caller not registry");
    });

    it("reverts if insufficient locked balance", async () => {
      await expect(
        vault.connect(registry).releaseForExecution(COMMITMENT, await token.getAddress(), DEPOSIT_AMOUNT + 1n, other.address)
      ).to.be.revertedWith("Vault: insufficient locked balance");
    });
  });

  // ── returnCollateral ───────────────────────────────────────────────────

  describe("returnCollateral", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit(await token.getAddress(), DEPOSIT_AMOUNT);
      await vault.connect(registry).lockCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("moves locked funds back to free balance", async () => {
      await vault.connect(registry).returnCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT);
      expect(await vault.freeBalance(user.address, await token.getAddress())).to.equal(DEPOSIT_AMOUNT);
      expect(await vault.lockedBalance(COMMITMENT, await token.getAddress())).to.equal(0);
    });

    it("emits CollateralReturned", async () => {
      await expect(
        vault.connect(registry).returnCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT)
      ).to.emit(vault, "CollateralReturned").withArgs(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT);
    });

    it("reverts if non-registry calls", async () => {
      await expect(
        vault.connect(other).returnCollateral(COMMITMENT, user.address, await token.getAddress(), DEPOSIT_AMOUNT)
      ).to.be.revertedWith("Vault: caller not registry");
    });
  });
});
