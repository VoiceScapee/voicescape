/**
 * One-off: create the five Voicescape Town Hall HCS topics.
 *
 * Usage:
 *   TOWNHALL_OPERATOR_ID=0.0.x TOWNHALL_OPERATOR_KEY=<key> \
 *     TOWNHALL_HCS_NETWORK=testnet npx tsx scripts/townhall-init.ts
 *
 * (tsx is available via npx — no install needed.)
 *
 * NEVER run this against mainnet without an explicit go from Brandon.
 * The operator here only needs to CREATE topics; the server operator can
 * be the same account or a different one.
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

async function main(): Promise<void> {
  const operatorId = process.env.TOWNHALL_OPERATOR_ID;
  const operatorKey = process.env.TOWNHALL_OPERATOR_KEY;
  const network = (process.env.TOWNHALL_HCS_NETWORK ?? "testnet").toLowerCase();
  if (!operatorId || !operatorKey) {
    throw new Error("Set TOWNHALL_OPERATOR_ID and TOWNHALL_OPERATOR_KEY first.");
  }
  if (network === "mainnet") {
    throw new Error(
      "Refusing to create topics on mainnet from this script — re-run with an explicit TOWNHALL_HCS_NETWORK=mainnet only after Brandon's go.",
    );
  }
  const client =
    network === "previewnet" ? Client.forPreviewnet() : Client.forTestnet();
  client.setOperator(operatorId, PrivateKey.fromString(operatorKey));

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
