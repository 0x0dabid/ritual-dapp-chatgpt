const hre = require("hardhat");

async function main() {
  console.log("\n🚀 Deploying PrivateMultiModalChatGPT to Ritual Chain…\n");
  console.log(`   RPC: ${hre.network.config.url}`);
  console.log(`   Chain ID: ${hre.network.config.chainId}`);

  // Get the first configured account (tested via RITUAL_PRIVATE_KEY)
  const [deployer] = await hre.ethers.getSigners();
  console.log(`   Deployer: ${deployer.address}`);

  // Deploy with initialOwner passed to Ownable constructor (OpenZeppelin v5)
  const Chat = await hre.ethers.getContractFactory("PrivateMultiModalChatGPT");
  const chat = await Chat.deploy(deployer.address);

  await chat.waitForDeployment();
  const address = await chat.getAddress();

  console.log("\n✅ PrivateMultiModalChatGPT deployed!");
  console.log(`   Contract: ${address}`);

  // Write .env.ritual for frontend propagation
  const envContent = [
    `# Ritual Chain Testnet — AUTO-GENERATED`,
    `NEXT_PUBLIC_RITUAL_CHAIN_ID=${hre.network.config.chainId}`,
    `NEXT_PUBLIC_RITUAL_RPC_URL=${hre.network.config.url}`,
    `NEXT_PUBLIC_CHATGPT_CONTRACT_ADDRESS=${address}`,
    `RITUAL_WALLET=0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948`,
    `TEE_SERVICE_REGISTRY=0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F`,
    ``,
  ].join("\n");

  const envPath = `${__dirname}/../.env.ritual`;
  require("fs").writeFileSync(envPath, envContent);
  require("fs").chmodSync(envPath, 0o600);

  console.log(`\n📄 Saved .env.ritual → ${envPath}`);
  console.log("   To configure frontend: cp .env.ritual ../web/.env.local\n");
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err);
  process.exitCode = 1;
});
