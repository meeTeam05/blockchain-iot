require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
require("./scripts/roles");

const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    // Same chain ID as Sepolia so the Schema v2 test vectors (domain chain_id
    // 11155111) verify against the contract in local tests.
    hardhat: { chainId: 11155111 },
    // `npx hardhat node` serves the hardhat network above (chain 11155111) for
    // local end-to-end runs; see spec/incident/deployments/localhost.json.
    localhost: { url: process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545", chainId: 11155111 },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  sourcify: { enabled: false },
};
