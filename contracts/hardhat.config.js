require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Hedera does not support Cancun-only opcodes (e.g. transient
      // storage via TSTORE/TLOAD, MCOPY, PUSH0), so target Paris.
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {},
    hederaTestnet: {
      chainId: 296,
      url: process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api",
      accounts:
        process.env.DEPLOYER_PRIVATE_KEY
          ? [process.env.DEPLOYER_PRIVATE_KEY]
          : [],
    },
    hederaMainnet: {
      chainId: 295,
      url: process.env.HEDERA_MAINNET_RPC || "https://mainnet.hashio.io/api",
      accounts:
        process.env.DEPLOYER_PRIVATE_KEY
          ? [process.env.DEPLOYER_PRIVATE_KEY]
          : [],
    },
    // Polygon-family networks have no trustworthy universal public RPC,
    // so they are only registered when their env vars are set. This keeps
    // `hardhat compile`/`test` working on a fresh checkout with no .env.
    ...(process.env.POLYGON_RPC_URL
      ? {
          polygon: {
            chainId: 137,
            url: process.env.POLYGON_RPC_URL,
            accounts: process.env.DEPLOYER_PRIVATE_KEY
              ? [process.env.DEPLOYER_PRIVATE_KEY]
              : [],
          },
        }
      : {}),
    ...(process.env.AMOY_RPC_URL
      ? {
          polygonAmoy: {
            chainId: 80002,
            url: process.env.AMOY_RPC_URL,
            accounts: process.env.DEPLOYER_PRIVATE_KEY
              ? [process.env.DEPLOYER_PRIVATE_KEY]
              : [],
          },
        }
      : {}),
  },
};
