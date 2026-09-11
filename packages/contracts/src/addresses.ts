/**
 * @voicescape/contracts — contract addresses.
 *
 * Addresses come from env (set after `npx hardhat run scripts/deploy.js`
 * in the contracts workspace). Mainnet deployment (2026-09-10):
 *
 *   Registry: 0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58 (0.0.10854058)
 *   Tips:     0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0 (0.0.10854060)
 *   Treasury: 0x30c63dc43608b6764a6b8b53960553aebf306817 (0.0.10424063)
 */

/** VoicescapeRegistry EVM address (NEXT_PUBLIC_REGISTRY_ADDRESS). */
export function getRegistryAddress(): string {
  const addr = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  if (!addr) throw new Error("NEXT_PUBLIC_REGISTRY_ADDRESS is not set — deploy the contracts and add the address to your env.");
  return addr;
}

/** VoicescapeTips EVM address (NEXT_PUBLIC_TIPS_ADDRESS). */
export function getTipsAddress(): string {
  const addr = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
  if (!addr) throw new Error("NEXT_PUBLIC_TIPS_ADDRESS is not set — deploy the contracts and add the address to your env.");
  return addr;
}
