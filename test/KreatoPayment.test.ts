import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { KreatoPayment } from "../typechain-types";

const PLATFORM_WALLET = process.env.PLATFORM_WALLET as `0x${string}`;
const FEE_BPS = 250n;
const BPS_DENOM = 10000n;

// Encode a product id the same way the frontend will
function encodeProductId(id: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(id));
}

describe("KreatoPayment", () => {

  if (!PLATFORM_WALLET) throw new Error("Missing PLATFORM_WALLET");

  // ── Fixture ────────────────────────────────────────────────────────────────

  async function deployFixture() {
    const [deployer, buyer, creator, other] = await ethers.getSigners();

    const KreatoPayment = await ethers.getContractFactory("KreatoPayment");
    const contract = await KreatoPayment.deploy(PLATFORM_WALLET) as KreatoPayment;
    await contract.waitForDeployment();

    // Deploy a mock ERC-20 (simulates USDC with 6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await usdc.waitForDeployment();

    // Mint 1000 USDC to buyer
    await usdc.mint(buyer.address, 1_000_000_000n); // 1000 USDC (6 decimals)

    return { contract, usdc, deployer, buyer, creator, other };
  }

  // ── Constants ──────────────────────────────────────────────────────────────

  describe("Constants", () => {
    it("has correct FEE_BPS", async () => {
      const { contract } = await loadFixture(deployFixture);
      expect(await contract.FEE_BPS()).to.equal(250n);
    });

    it("has correct PLATFORM_WALLET", async () => {
      const { contract } = await loadFixture(deployFixture);
      expect(await contract.PLATFORM_WALLET()).to.equal(PLATFORM_WALLET);
    });
  });

  // ── calculateSplit ─────────────────────────────────────────────────────────

  describe("calculateSplit", () => {
    it("correctly splits 1 USDC (1_000_000 units)", async () => {
      const { contract } = await loadFixture(deployFixture);
      const [creatorAmt, fee] = await contract.calculateSplit(1_000_000n);
      expect(creatorAmt).to.equal(975_000n); // $0.975
      expect(fee).to.equal(25_000n);          // $0.025
    });

    it("correctly splits 100 USDC", async () => {
      const { contract } = await loadFixture(deployFixture);
      const [creatorAmt, fee] = await contract.calculateSplit(100_000_000n);
      expect(creatorAmt).to.equal(97_500_000n);
      expect(fee).to.equal(2_500_000n);
    });

    it("creatorAmount + platformFee = totalAmount always", async () => {
      const { contract } = await loadFixture(deployFixture);
      const amounts = [1n, 100n, 999n, 1_000_000n, 123_456_789n];
      for (const amount of amounts) {
        const [creatorAmt, fee] = await contract.calculateSplit(amount);
        expect(creatorAmt + fee).to.equal(amount);
      }
    });
  });

  // ── payWithETH ─────────────────────────────────────────────────────────────

  describe("payWithETH", () => {
    it("splits ETH correctly between creator and platform", async () => {
      const { contract, buyer, creator } = await loadFixture(deployFixture);
      const productId = encodeProductId("product-123");
      const amount = ethers.parseEther("1.0"); // 1 ETH

      const expectedCreator = (amount * (BPS_DENOM - FEE_BPS)) / BPS_DENOM;
      const expectedPlatform = amount - expectedCreator;

      const creatorBefore = await ethers.provider.getBalance(creator.address);
      const platformBefore = await ethers.provider.getBalance(PLATFORM_WALLET);

      await contract.connect(buyer).payWithETH(
        creator.address,
        productId,
        0, // PaymentType.PURCHASE
        { value: amount }
      );

      const creatorAfter = await ethers.provider.getBalance(creator.address);
      const platformAfter = await ethers.provider.getBalance(PLATFORM_WALLET);

      expect(creatorAfter - creatorBefore).to.equal(expectedCreator);
      expect(platformAfter - platformBefore).to.equal(expectedPlatform);
    });

    it("emits PaymentProcessed event", async () => {
      const { contract, buyer, creator } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1.0");
      const productId = encodeProductId("product-456");

      await expect(
        contract.connect(buyer).payWithETH(creator.address, productId, 0, { value: amount })
      ).to.emit(contract, "PaymentProcessed")
        .withArgs(
          buyer.address,
          creator.address,
          ethers.ZeroAddress,
          amount,
          (amount * 9750n) / 10000n,
          (amount * 250n) / 10000n,
          productId,
          0
        );
    });

    it("reverts if amount is 0", async () => {
      const { contract, buyer, creator } = await loadFixture(deployFixture);
      await expect(
        contract.connect(buyer).payWithETH(creator.address, ethers.ZeroHash, 0, { value: 0 })
      ).to.be.revertedWith("KreatoPayment: amount must be > 0");
    });

    it("reverts if creator is zero address", async () => {
      const { contract, buyer } = await loadFixture(deployFixture);
      await expect(
        contract.connect(buyer).payWithETH(
          ethers.ZeroAddress, ethers.ZeroHash, 0, { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("KreatoPayment: invalid creator address");
    });

    it("reverts if creator is platform wallet", async () => {
      const { contract, buyer } = await loadFixture(deployFixture);
      await expect(
        contract.connect(buyer).payWithETH(
          PLATFORM_WALLET, ethers.ZeroHash, 0, { value: ethers.parseEther("1") }
        )
      ).to.be.revertedWith("KreatoPayment: creator cannot be platform");
    });

    it("reverts on direct ETH send (no function call)", async () => {
      const { contract, buyer } = await loadFixture(deployFixture);
      await expect(
        buyer.sendTransaction({ to: await contract.getAddress(), value: ethers.parseEther("1") })
      ).to.be.revertedWith("KreatoPayment: use payWithETH()");
    });
  });

  // ── payWithToken ───────────────────────────────────────────────────────────

  describe("payWithToken", () => {
    it("splits USDC correctly between creator and platform", async () => {
      const { contract, usdc, buyer, creator } = await loadFixture(deployFixture);
      const amount = 1_000_000n; // 1 USDC
      const productId = encodeProductId("product-789");

      const expectedCreator = (amount * (BPS_DENOM - FEE_BPS)) / BPS_DENOM;
      const expectedPlatform = amount - expectedCreator;

      // Approve contract to spend buyer's USDC
      await usdc.connect(buyer).approve(await contract.getAddress(), amount);

      const creatorBefore = await usdc.balanceOf(creator.address);
      const platformBefore = await usdc.balanceOf(PLATFORM_WALLET);
      const buyerBefore = await usdc.balanceOf(buyer.address);

      await contract.connect(buyer).payWithToken(
        await usdc.getAddress(),
        amount,
        creator.address,
        productId,
        0 // PURCHASE
      );

      expect(await usdc.balanceOf(creator.address) - creatorBefore).to.equal(expectedCreator);
      expect(await usdc.balanceOf(PLATFORM_WALLET) - platformBefore).to.equal(expectedPlatform);
      expect(buyerBefore - await usdc.balanceOf(buyer.address)).to.equal(amount);
    });

    it("emits PaymentProcessed event for token payment", async () => {
      const { contract, usdc, buyer, creator } = await loadFixture(deployFixture);
      const amount = 5_000_000n; // 5 USDC
      const productId = encodeProductId("membership-abc");

      await usdc.connect(buyer).approve(await contract.getAddress(), amount);

      await expect(
        contract.connect(buyer).payWithToken(
          await usdc.getAddress(), amount, creator.address, productId, 2 // SUBSCRIPTION
        )
      ).to.emit(contract, "PaymentProcessed")
        .withArgs(
          buyer.address,
          creator.address,
          await usdc.getAddress(),
          amount,
          (amount * 9750n) / 10000n,
          (amount * 250n) / 10000n,
          productId,
          2
        );
    });

    it("reverts if amount is 0", async () => {
      const { contract, usdc, buyer, creator } = await loadFixture(deployFixture);
      await expect(
        contract.connect(buyer).payWithToken(
          await usdc.getAddress(), 0, creator.address, ethers.ZeroHash, 0
        )
      ).to.be.revertedWith("KreatoPayment: amount must be > 0");
    });

    it("reverts if token is zero address", async () => {
      const { contract, buyer, creator } = await loadFixture(deployFixture);
      await expect(
        contract.connect(buyer).payWithToken(
          ethers.ZeroAddress, 1_000_000n, creator.address, ethers.ZeroHash, 0
        )
      ).to.be.revertedWith("KreatoPayment: invalid token address");
    });

    it("reverts if creator is zero address", async () => {
      const { contract, usdc, buyer } = await loadFixture(deployFixture);
      await usdc.connect(buyer).approve(await contract.getAddress(), 1_000_000n);
      await expect(
        contract.connect(buyer).payWithToken(
          await usdc.getAddress(), 1_000_000n, ethers.ZeroAddress, ethers.ZeroHash, 0
        )
      ).to.be.revertedWith("KreatoPayment: invalid creator address");
    });

    it("reverts if buyer has insufficient allowance", async () => {
      const { contract, usdc, buyer, creator } = await loadFixture(deployFixture);
      // No approval — should revert
      await expect(
        contract.connect(buyer).payWithToken(
          await usdc.getAddress(), 1_000_000n, creator.address, ethers.ZeroHash, 0
        )
      ).to.be.reverted;
    });

    it("reverts if buyer has insufficient balance", async () => {
      const { contract, usdc, other, creator } = await loadFixture(deployFixture);
      // `other` has no USDC
      await usdc.connect(other).approve(await contract.getAddress(), 1_000_000n);
      await expect(
        contract.connect(other).payWithToken(
          await usdc.getAddress(), 1_000_000n, creator.address, ethers.ZeroHash, 0
        )
      ).to.be.reverted;
    });

    it("handles subscription payment type correctly", async () => {
      const { contract, usdc, buyer, creator } = await loadFixture(deployFixture);
      const amount = 8_000_000n; // $8 membership
      await usdc.connect(buyer).approve(await contract.getAddress(), amount);

      await expect(
        contract.connect(buyer).payWithToken(
          await usdc.getAddress(), amount, creator.address,
          encodeProductId("membership-xyz"), 2 // SUBSCRIPTION
        )
      ).to.emit(contract, "PaymentProcessed");
    });
  });
});
