/**
 * One-off: create the five Voicescape Town Hall HCS topics.
 *
 * Usage:
 *   TOWNHALL_OPERATOR_ID=0.0.x TOWNHALL_OPERATOR_KEY=<key> \
 *     TOWNHALL_HCS_NETWORK=testnet npx tsx scripts/townhall-init.ts
 *
 * Mainnet (only with Brandon's explicit go):
 *   CONFIRM_MAINNET=1 TOWNHALL_OPERATOR_ID=0.0.x TOWNHALL_OPERATOR_KEY=<key> \
 *     TOWNHALL_HCS_NETWORK=mainnet npx tsx scripts/townhall-init.ts
 *
 * (tsx is available via npx — no install needed.)
 */

import {
  Client,
  PrivateKey,
  TopicCreateTransaction,
} from "@hashgraph/sdk";

const DOMAINS = [
  { domain: "forum", memo: "Voicescape Town Hall — forum (posts, walls, replies)" },
  { domain: "chat", memo: "Voicescape Town Hall — chat rooms" },
  { domain: "votes", memo: "Voicescape Town Hall — reputation votes" },
  { domain: "governance", memo: "Voicescape Town Hall — proposals, votes, events" },
  { domain: "market", memo: "Voicescape Town Hall — marketplace listings" },
] as const;

/**
 * Parse the operator key explicitly.
 *
 * A raw 64-char hex string is ambiguous: it could be an ED25519 or an ECDSA
 * key, and PrivateKey.fromString() guesses (usually ED25519), which produces
 * INVALID_SIGNATURE for ECDSA accounts. Since the mainnet operator is ECDSA,
 * raw hex is parsed as ECDSA explicitly. DER/0x-prefixed forms keep the
 * generic parser.
 */
function parseOperatorKey(s: string): PrivateKey {
  const hex = s.startsWith("0x") ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return PrivateKey.fromStringECDSA(hex);
  }
  return PrivateKey.fromString(s);
}

async function main(): Promise<void> {
  const operatorId = process.env.TOWNHALL_OPERATOR_ID;
  const operatorKey = process.env.TOWNHALL_OPERATOR_KEY;
  const network = (process.env.TOWNHALL_HCS_NETWORK ?? "testnet").toLowerCase();
  if (!operatorId || !operatorKey) {
    throw new Error("Set TOWNHALL_OPERATOR_ID and TOWNHALL_OPERATOR_KEY first.");
  }
  // Mainnet requires Brandon's explicit go, expressed as CONFIRM_MAINNET=1
  // (mirrors the CONFIRM_MAINNET rail in contracts/scripts/deploy.js).
  if (network === "mainnet" && process.env.CONFIRM_MAINNET !== "1") {
    throw new Error(
      "Refusing to create topics on mainnet without CONFIRM_MAINNET=1."
    );
  }
  const client =
    network === "mainnet"
      ? Client.forMainnet()
      : network === "previewnet"
        ? Client.forPreviewnet()
        : Client.forTestnet();
  client.setOperator(operatorId, parseOperatorKey(operatorKey));

  const ids: Record<string, string> = {};
  for (const { domain, memo } of DOMAINS) {
    const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId?.toString();
    if (!topicId) throw new Error(`Topic creation for "${domain}" returned no topic id.`);
    ids[domain] = topicId;
    console.log(`${domain}: ${topicId}`);
  }
  client.close();

  console.log("\nAdd these to your env and restart the server:");
  console.log(`TOWNHALL_TOPIC_FORUM=${ids.forum}`);
  console.log(`TOWNHALL_TOPIC_CHAT=${ids.chat}`);
  console.log(`TOWNHALL_TOPIC_VOTES=${ids.votes}`);
  console.log(`TOWNHALL_TOPIC_GOV=${ids.governance}`);
  console.log(`TOWNHALL_TOPIC_MARKET=${ids.market}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
