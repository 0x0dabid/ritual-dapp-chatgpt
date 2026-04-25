import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    hardhat: {},
    testnet: {
      url: process.env.RITUAL_RPC_URL || "https://rpc.ritualfoundation.org",
      chainId: 1979,
      accounts: process.env.RITUAL_PRIVATE_KEY ? [process.env.RITUAL_PRIVATE_KEY] : [],
    }
  }
};

export default config;
