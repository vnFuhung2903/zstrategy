import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { MockERC20, UniswapV3Adapter, MockSwapRouter } from "../typechain-types";

describe("UniswapV3Adapter", () => {
  let owner: SignerWithAddress;
  let recipient: SignerWithAddress;

  let tokenIn: MockERC20;
  let tokenOut: MockERC20;
  let router: MockSwapRouter;

  const FEE_TIER = 500;             // 0.05% — Uniswap v3 stable-pair pool
  const DEFAULT_BUFFER = 300;       // 5 minutes
  const AMOUNT_IN = ethers.parseUnits("1000", 6);  // 1000 USDC
  const MIN_OUT   = ethers.parseUnits("0.3", 18);  // 0.3 WETH (mock pays exactly this)

  beforeEach(async () => {
    [owner, recipient] = await ethers.getSigners();

    const ERC20F = await ethers.getContractFactory("MockERC20");
    tokenIn  = (await ERC20F.deploy("Mock USDC", "USDC", 6))  as unknown as MockERC20;
    tokenOut = (await ERC20F.deploy("Mock WETH", "WETH", 18)) as unknown as MockERC20;

    const RouterF = await ethers.getContractFactory("MockSwapRouter");
    router = (await RouterF.deploy()) as unknown as MockSwapRouter;
    await router.setMockOut(MIN_OUT);
  });

  describe("constructor", () => {
    it("reverts on zero deadline buffer", async () => {
      const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
      await expect(
        AdapterF.deploy(await router.getAddress(), FEE_TIER, 0)
      ).to.be.revertedWith("Adapter: zero deadline buffer");
    });

    it("exposes the configured deadline buffer", async () => {
      const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
      const adapter = (await AdapterF.deploy(
        await router.getAddress(), FEE_TIER, DEFAULT_BUFFER
      )) as unknown as UniswapV3Adapter;
      expect(await adapter.swapDeadlineBuffer()).to.equal(DEFAULT_BUFFER);
      expect(await adapter.feeTier()).to.equal(FEE_TIER);
      expect(await adapter.router()).to.equal(await router.getAddress());
    });
  });

  describe("swap", () => {
    it("passes block.timestamp + buffer as deadline to the router", async () => {
      const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
      const adapter = (await AdapterF.deploy(
        await router.getAddress(), FEE_TIER, DEFAULT_BUFFER
      )) as unknown as UniswapV3Adapter;

      // Fund the adapter (real flow: CollateralVault.releaseForExecution sends
      // tokens to the adapter before swap()).
      await tokenIn.mint(await adapter.getAddress(), AMOUNT_IN);

      const tx = await adapter.swap(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        AMOUNT_IN,
        MIN_OUT,
        recipient.address,
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await router.lastDeadline()).to.equal(BigInt(block!.timestamp) + BigInt(DEFAULT_BUFFER));
    });

    it("uses a custom buffer when constructed with one", async () => {
      const customBuffer = 1800; // 30 minutes
      const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
      const adapter = (await AdapterF.deploy(
        await router.getAddress(), FEE_TIER, customBuffer
      )) as unknown as UniswapV3Adapter;

      await tokenIn.mint(await adapter.getAddress(), AMOUNT_IN);

      const tx = await adapter.swap(
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        AMOUNT_IN,
        MIN_OUT,
        recipient.address,
      );
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await router.lastDeadline()).to.equal(BigInt(block!.timestamp) + BigInt(customBuffer));
    });

    it("only approves the router once per token (lazy forceApprove)", async () => {
      const AdapterF = await ethers.getContractFactory("UniswapV3Adapter");
      const adapter = (await AdapterF.deploy(
        await router.getAddress(), FEE_TIER, DEFAULT_BUFFER
      )) as unknown as UniswapV3Adapter;

      await tokenIn.mint(await adapter.getAddress(), AMOUNT_IN * 2n);

      // Count Approval events emitted by tokenIn for (adapter → router). For
      // standard ERC-20s (where approve() returns true cleanly), OZ's
      // forceApprove emits exactly one Approval event per call. If the
      // adapter's lazy guard works, we see exactly one event across both
      // swaps (cold approve on swap #1, none on swap #2). A broken guard
      // would call forceApprove twice and emit two events.
      const filter = tokenIn.filters.Approval(
        await adapter.getAddress(),
        await router.getAddress(),
      );
      const startBlock = await ethers.provider.getBlockNumber();

      await adapter.swap(
        await tokenIn.getAddress(), await tokenOut.getAddress(),
        AMOUNT_IN, MIN_OUT, recipient.address,
      );
      await adapter.swap(
        await tokenIn.getAddress(), await tokenOut.getAddress(),
        AMOUNT_IN, MIN_OUT, recipient.address,
      );

      const events = await tokenIn.queryFilter(filter, startBlock);
      expect(events.length).to.equal(1);
    });
  });
});
