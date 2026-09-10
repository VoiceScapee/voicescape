require("dotenv").config();

const MAINNET_NETWORKS = ["hederaMainnet", "polygon"];

/**
 * Deploy VoicescapeRegistry, then VoicescapeTips(registry, treasury).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hederaTestnet
 *   DRY_RUN=1 npx hardhat run scripts/deploy.js --network hederaMainnet
 *     (safe: validates config, never spends, no deployer key needed)
 *
 * Safety rail: deploying to a MAINNET network requires explicit confirmation
 * via the CONFIRM_MAINNET=1 env var, e.g.:
 *   CONFIRM_MAINNET=1 npx hardhat run scripts/deploy.js --network hederaMainnet
 *
 * NOTE: hardhat rejects unknown CLI flags (HH305), so confirmation is done
 * via env var, not a --confirm-mainnet CLI flag.
 *
 * Env:
 *   TREASURY_ADDRESS    - wallet/contract receiving the 2% platform fee (required)
 *   DEPLOYER_PRIVATE_KEY- deployer account key (required on live networks)
 *   CONFIRM_MAINNET=1   - required to deploy to a mainnet network
 *   DRY_RUN=1           - validate config and exit before any network spend
 */
async function main() {
  const networkName = network.name;
  const dryRun =
    process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
  const confirmed =
    process.argv.includes("--confirm-mainnet") ||
    process.env.CONFIRM_MAINNET === "1";

  // Dry run: validate config and exit BEFORE any network interaction or spend.
  // Needs no --confirm-mainnet and no deployer key. Provably spend-free.
  if (dryRun) {
    console.log("=== DRY RUN — nothing will be deployed, nothing will be spent ===");
    const treasury = process.env.TREASURY_ADDRESS;
    if (!treasury || !/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
      throw new Error(
        "DRY RUN FAILED: TREASURY_ADDRESS env var must be a valid 0x address."
      );
    }
    console.log(`Network:  ${networkName}`);
    console.log(`Treasury: ${treasury}`);
    console.log("Would deploy, in order:");
    console.log("  1. VoicescapeRegistry");
    console.log("  2. VoicescapeTips(registry, treasury)");
    console.log(`Would write deployments/${networkName}.json`);
    console.log("=== DRY RUN OK — exiting without spending anything ===");
    return;
  }

  if (MAINNET_NETWORKS.includes(networkName)) {
    const confirmed =
      process.argv.includes("--confirm-mainnet") ||
      process.env.CONFIRM_MAINNET === "1";
    if (!confirmed) {
      throw new Error(
        `Refusing to deploy to mainnet network "${networkName}" without ` +
          "CONFIRM_MAINNET=1. Re-run with CONFIRM_MAINNET=1 if you really mean it."
      );
    }
    console.log(`!! MAINNET deploy confirmed for ${networkName} !!`);
  }

  const treasury = process.env.TREASURY_ADDRESS;
  if (!treasury || treasury === "0x0000000000000000000000000000000000000000") {
    throw new Error("TREASURY_ADDRESS env var is required (non-zero address).");
  }

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      `No deployer account configured for network "${networkName}". ` +
        "Set DEPLOYER_PRIVATE_KEY in your .env (never commit it)."
    );
  }
  const deployer = signers[0];
  console.log(`Network:  ${networkName}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Treasury: ${treasury}`);

  console.log("\nDeploying VoicescapeRegistry...");
  const Registry = await ethers.getContractFactory("VoicescapeRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`VoicescapeRegistry deployed at: ${registryAddress}`);

  console.log("\nDeploying VoicescapeTips...");
  const Tips = await ethers.getContractFactory("VoicescapeTips");
  const tips = await Tips.deploy(registryAddress, treasury);
  await tips.waitForDeployment();
  const tipsAddress = await tips.getAddress();
  console.log(`VoicescapeTips deployed at:     ${tipsAddress}`);

  console.log("\n--- Deployment summary ---");
  console.log(`network:          ${networkName}`);
  console.log(`VoicescapeRegistry: ${registryAddress}`);
  console.log(`VoicescapeTips:     ${tipsAddress}`);
  console.log(`treasury:         ${treasury}`);

  // Persist the deployment so the frontend can be wired without copy-paste.
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${networkName}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        network: networkName,
        chainId: network.config.chainId,
        VoicescapeRegistry: registryAddress,
        VoicescapeTips: tipsAddress,
        treasury,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  console.log(`\nDeployment written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
