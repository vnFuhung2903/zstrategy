import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { GasVault } from "../typechain-types";

describe("GasVault", () => {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let registry: SignerWithAddress;
  let keeper: SignerWithAddress;
  let other: SignerWithAddress;

  let vault: GasVault;

  const DEPOSIT = ethers.parseEther("0.01");
  const COMMITMENT = ethers.keccak256(ethers.toUtf8Bytes("commitment-1"));

  beforeEach(async () => {
    [owner, user, registry, keeper, other] = await ethers.getSigners();

    const VaultF = await ethers.getContractFactory("GasVault");
    vault = (await VaultF.deploy()) as unknown as GasVault;
    await vault.connect(owner).setRegistry(registry.address);
  });

  // ── setRegistry ────────────────────────────────────────────────────────

  describe("setRegistry", () => {
    it("can only be called by owner", async () => {
      const VaultF = await ethers.getContractFactory("GasVault");
      const fresh = (await VaultF.deploy()) as unknown as GasVault;
      await expect(fresh.connect(other).setRegistry(registry.address))
        .to.be.revertedWith("GasVault: not owner");
    });

    it("cannot be called twice", async () => {
      await expect(vault.connect(owner).setRegistry(other.address))
        .to.be.revertedWith("GasVault: registry already set");
    });

    it("reverts on zero registry", async () => {
      const VaultF = await ethers.getContractFactory("GasVault");
      const fresh = (await VaultF.deploy()) as unknown as GasVault;
      await expect(fresh.connect(owner).setRegistry(ethers.ZeroAddress))
        .to.be.revertedWith("GasVault: zero registry");
    });
  });

  // ── deposit ────────────────────────────────────────────────────────────

  describe("deposit", () => {
    it("explicit deposit() increases balanceOf and emits Deposited", async () => {
      await expect(vault.connect(user).deposit({ value: DEPOSIT }))
        .to.emit(vault, "Deposited")
        .withArgs(user.address, DEPOSIT);
      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT);
    });

    it("receive() (raw send) increases balanceOf and emits Deposited", async () => {
      await expect(user.sendTransaction({ to: await vault.getAddress(), value: DEPOSIT }))
        .to.emit(vault, "Deposited")
        .withArgs(user.address, DEPOSIT);
      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT);
    });

    it("reverts on zero deposit", async () => {
      await expect(vault.connect(user).deposit({ value: 0 }))
        .to.be.revertedWith("GasVault: zero deposit");
    });

    it("accumulates across multiple deposits", async () => {
      await vault.connect(user).deposit({ value: DEPOSIT });
      await vault.connect(user).deposit({ value: DEPOSIT });
      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT * 2n);
    });
  });

  // ── withdraw ───────────────────────────────────────────────────────────

  describe("withdraw", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit({ value: DEPOSIT });
    });

    it("decreases balanceOf and transfers ETH back", async () => {
      await expect(vault.connect(user).withdraw(DEPOSIT))
        .to.changeEtherBalances([user, vault], [DEPOSIT, -DEPOSIT]);
      expect(await vault.balanceOf(user.address)).to.equal(0);
    });

    it("emits Withdrawn", async () => {
      await expect(vault.connect(user).withdraw(DEPOSIT))
        .to.emit(vault, "Withdrawn")
        .withArgs(user.address, DEPOSIT);
    });

    it("reverts on zero amount", async () => {
      await expect(vault.connect(user).withdraw(0))
        .to.be.revertedWith("GasVault: zero amount");
    });

    it("reverts if amount exceeds balance", async () => {
      await expect(vault.connect(user).withdraw(DEPOSIT + 1n))
        .to.be.revertedWith("GasVault: insufficient");
    });
  });

  // ── debit ──────────────────────────────────────────────────────────────

  describe("debit", () => {
    beforeEach(async () => {
      await vault.connect(user).deposit({ value: DEPOSIT });
    });

    it("decrements user balance and forwards ETH to keeper", async () => {
      const cost = ethers.parseEther("0.001");
      await expect(vault.connect(registry).debit(user.address, keeper.address, cost, COMMITMENT))
        .to.changeEtherBalances([vault, keeper], [-cost, cost]);
      expect(await vault.balanceOf(user.address)).to.equal(DEPOSIT - cost);
    });

    it("emits Debited", async () => {
      const cost = ethers.parseEther("0.001");
      await expect(vault.connect(registry).debit(user.address, keeper.address, cost, COMMITMENT))
        .to.emit(vault, "Debited")
        .withArgs(user.address, keeper.address, cost, COMMITMENT);
    });

    it("reverts when called by non-registry", async () => {
      const cost = ethers.parseEther("0.001");
      await expect(vault.connect(other).debit(user.address, keeper.address, cost, COMMITMENT))
        .to.be.revertedWith("GasVault: not registry");
    });

    it("reverts when balance is insufficient", async () => {
      const cost = DEPOSIT + 1n;
      await expect(vault.connect(registry).debit(user.address, keeper.address, cost, COMMITMENT))
        .to.be.revertedWith("GasVault: insufficient gas balance");
    });
  });
});
