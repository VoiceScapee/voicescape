/**
 * @voicescape/contracts — contract ABIs.
 *
 * Human-readable ABIs, verified against
 * contracts/artifacts/.../VoicescapeRegistry.json and VoicescapeTips.json —
 * function names and signatures match exactly.
 */

export const REGISTRY_ABI = [
  // Phase B: ownerType 0 = HUMAN, 1 = AGENT. Agents MUST supply operator + purpose
  // (the contract reverts otherwise); humans pass the zero address + "".
  "function registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)",
  "function updatePage(string username, string ipfsHash)",
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
  "function usernameExists(string username) view returns (bool)",
] as const;

export const TIPS_ABI = [
  "function tipPage(string username) payable",
  "function buyListing(address seller, string listingRef) payable",
  "function treasury() view returns (address)",
] as const;
