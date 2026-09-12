/**
 * Voicescape "Link an AI agent" — message construction and parsing.
 *
 * A signed-in human links their AI agent by signing ONE message with their
 * wallet. The message binds the human's wallet address to the agent's
 * Hedera account id, plus a nonce + timestamp so the signature can't be
 * replayed for a different agent or at a later date.
 *
 * This module is shared by the browser (build the message, then sign it
 * with the wallet) and the server (parse + validate the signed message).
 * It is PURE: no browser or Node-only APIs.
 *
 * Message format:
 *
 *   Voicescape wants to link an AI agent:
 *
 *   <userAddress>
 *
 *   Agent account: <0.0.x>
 *   App: Voicescape
 *   URI: <origin>               (binds the signature to this deployment —
 *                              a signature minted for another site is rejected)
 *   Nonce: <32 hex chars>
 *   Issued At: <ISO-8601>
 */

import { canonicalAddress } from "./session-message";

/** Header agents send instead of a wallet session. */
export const AGENT_KEY_HEADER = "x-vs-agent-key";
/** Prefix of every issued agent API key (also the key-hint shown in UI). */
export const AGENT_KEY_PREFIX = "vsak_";

export interface LinkMessageFields {
  /** As written in the message: 0x… (EVM) or 0.0.x (Hedera). */
  userAddress: string;
  /** The agent's Hedera account id, 0.0.x. */
  agentAccountId: string;
  /** Origin the link is addressed to, e.g. "https://voicescape.vercel.app". */
  uri: string;
  nonce: string;
  issuedAt: string;
}

export function buildLinkMessage(f: LinkMessageFields): string {
  return [
    `Voicescape wants to link an AI agent:`,
    ``,
    f.userAddress,
    ``,
    `Agent account: ${f.agentAccountId}`,
    `App: Voicescape`,
    `URI: ${f.uri}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  ].join("\n");
}

/**
 * Strictly parse a link message. Returns null for anything that is not
 * exactly the format buildLinkMessage produces.
 */
export function parseLinkMessage(message: string): LinkMessageFields | null {
  if (typeof message !== "string" || message.length > 2000) return null;
  const lines = message.split("\n");
  if (lines.length !== 9) return null;
  if (lines[0] !== "Voicescape wants to link an AI agent:") return null;
  if (lines[1] !== "" || lines[3] !== "") return null;

  const userAddress = lines[2].trim();
  if (!canonicalAddress(userAddress)) return null;

  const agentM = /^Agent account: (0\.0\.\d+)$/.exec(lines[4].trim());
  if (!agentM) return null;

  if (lines[5].trim() !== "App: Voicescape") return null;

  const uriM = /^URI: (\S+)$/.exec(lines[6].trim());
  const nonceM = /^Nonce: ([0-9a-f]{32})$/.exec(lines[7].trim());
  const issuedM = /^Issued At: (\S+)$/.exec(lines[8].trim());
  if (!uriM || !nonceM || !issuedM) return null;
  if (!Number.isFinite(Date.parse(issuedM[1]))) return null;

  return {
    userAddress,
    agentAccountId: agentM[1],
    uri: uriM[1],
    nonce: nonceM[1],
    issuedAt: issuedM[1],
  };
}
