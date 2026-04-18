import { ethers, network, run } from "hardhat";

function getEnvKeys(networkName: string) {
  switch (networkName) {
    case "sepolia":
      return {
        payment: "NEXT_PUBLIC_KREATO_CONTRACT_SEPOLIA",
        usdc: "NEXT_PUBLIC_USDC_SEPOLIA",
      };
    case "baseSepolia":
      return {
        payment: "NEXT_PUBLIC_KREATO_CONTRACT_BASE_SEPOLIA",
        usdc: "NEXT_PUBLIC_USDC_BASE_SEPOLIA",
      };
    case "mainnet":
      return {
        payment: "NEXT_PUBLIC_KREATO_CONTRACT_ETH",
        usdc: "NEXT_PUBLIC_USDC_ETH",
      };
    case "base":
      return {
        payment: "NEXT_PUBLIC_KREATO_CONTRACT_BASE",
        usdc: "NEXT_PUBLIC_USDC_BASE",
      };
    default:
      throw new Error(`Unsupported network: ${networkName}`);
  }
}

async function main() {
  const platformWallet = process.env.PLATFORM_WALLET;
  const [deployer] = await ethers.getSigners();

  console.log("Network:", network.name);
  console.log("Deployer:", deployer.address);

  if (!platformWallet) throw new Error("Missing PLATFORM_WALLET");

  // ─── Deploy Mock USDC ─────────────────────────────
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();

  const usdcAddress = await usdc.getAddress();
  console.log("\nMock USDC deployed to:", usdcAddress);

  // Mint ke diri sendiri
  const mintAmount = ethers.parseUnits("1000", 6); // 1000 USDC
  console.log("Minted 1000 USDC to:", deployer.address);

  const mintTx = await usdc.mint(deployer.address, mintAmount);
  await mintTx.wait(); // 🔥 WAJIB

  // ─── Deploy KreatoPayment ─────────────────────────
  const KreatoPayment = await ethers.getContractFactory("KreatoPayment");
  const payment = await KreatoPayment.deploy(platformWallet);
  await payment.waitForDeployment();

  const paymentAddress = await payment.getAddress();
  console.log("\nKreatoPayment deployed to:", paymentAddress);

  // ─── ENV output ───────────────────────────────────
  const keys = getEnvKeys(network.name);

  console.log("\n─── ENV ───────────────────────────");
  console.log(`${keys.payment}=${paymentAddress}`);
  console.log(`${keys.usdc}=${usdcAddress}`);
  console.log(`PLATFORM_WALLET=${platformWallet}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
