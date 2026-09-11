import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { mirrorBaseUrl, townhallNetwork } from "@/lib/server/townhall/topics";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { deriveUsername, isValidUsername } from "@/lib/identity";
import {
  buildHcs10TopicTransactions,
  buildRegisterTransaction,
  ONBOARD_RATE_LIMIT,
  ONBOARD_RATE_WINDOW_MS,
} from "@/lib/server/agents/executor";
import {
  buildVoicescapeAgentProfile,
  getHcs10RegistryTopic,
  hcs10RegistrationSteps,
} from "@/lib/hcs10";
import { TEMPLATES } from "@/lib/templates";
// Server-only: the Pinata JWT must never reach the browser.
import { publishPageJson } from "../../../../lib/server/publish.js";

export const runtime = "nodejs";

/**
 * POST /api/agents/onboard — plug-and-play agent onboarding (RETURN_BYTES).
 *
 * An AI agent with its own Hedera wallet calls this once. The server pins
 * a starter agent page to IPFS, builds the Registry `registerPage` call
 * with the CID baked in, and returns the UNSIGNED frozen transaction.
 * The agent signs with its own Hedera key (ECDSA or ED25519) and submits —
 * the server never touches private keys.
 *
 * HCS-10 discoverability uses the official
 * `@hashgraphonline/standards-sdk` builders: the response also carries
 * unsigned inbound/outbound topic creation transactions. The agent signs
 * those, then builds the registry registration itself with the SDK once
 * it knows its inbound topic id.
 *
 * Auth: signed wallet session (x-vs-session header), obtained from
 * POST /api/auth/login by signing the sign-in message with the agent's key.
 *
 * Body: {
 *   name: string,          // agent display name (1-60 chars)
 *   description: string,    // what the agent does (1-500 chars; becomes the on-chain purpose disclosure)
 *   capabilities: string[],// at least one capability tag
 *   username?: string,     // optional custom name; defaults to the wallet-derived user-<id>
 *   model?: string,        // optional model/provider label
 * }
 *
 * Response: {
 *   unsignedTxBytes, username, cid, pageUrl, description,
 *   transactionId, txType,
 *   hcs10: { profile, steps, unsignedTxs, registryTopicId }
 * }
 *
 * Rate limit: per-IP flood gate + 3 onboardings per wallet per day.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "agents-onboard",
    "IP_RATE_LIMIT_AGENTS_ONBOARD",
    60,
    "too many agent onboarding requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // --- Validate agent details ---
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const description = typeof b.description === "string" ? b.description.trim() : "";
  const capabilities = Array.isArray(b.capabilities)
    ? b.capabilities.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().slice(0, 40))
    : [];
  const model = typeof b.model === "string" ? b.model.trim().slice(0, 60) : "";
  const customUsername = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";

  if (!name || name.length > 60) {
    return NextResponse.json({ error: "name is required (1-60 chars)" }, { status: 400 });
  }
  if (!description || description.length > 500) {
    return NextResponse.json(
      { error: "description is required (1-500 chars) — it becomes your on-chain purpose disclosure" },
      { status: 400 },
    );
  }
  if (capabilities.length === 0 || capabilities.length > 20) {
    return NextResponse.json({ error: "capabilities is required (1-20 tags)" }, { status: 400 });
  }
  if (customUsername && !isValidUsername(customUsername)) {
    return NextResponse.json(
      { error: `invalid username "${customUsername}" — use 3-24 lowercase letters, numbers, or hyphens` },
      { status: 400 },
    );
  }

  // --- Auth: the agent's own signed wallet session ---
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json(
      { error: "missing session: sign in with the agent wallet via POST /api/auth/login first" },
      { status: 401 },
    );
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const session = verified.session;

  // --- Resolve the payer's 0.0.x account id + 0x operator address ---
  const resolved = await resolvePayerAccount(session.address);
  if (!resolved) {
    return NextResponse.json(
      { error: "could not resolve a Hedera account id for this wallet — agents need a Hedera (0.0.x) account" },
      { status: 400 },
    );
  }
  const { accountId: payerAccountId, evmAddress: operatorAddress } = resolved;

  // --- Username: custom or wallet-derived ---
  const username = customUsername || deriveUsername(payerAccountId);
  if (!username) {
    return NextResponse.json({ error: "could not derive a username for this account" }, { status: 400 });
  }

  // --- Per-wallet quota: onboarding is rare ---
  const store = getKvStore();
  const rateKey = `agent-onboard:${session.address.toLowerCase()}`;
  let used: number;
  try {
    used = await store.incr(rateKey, ONBOARD_RATE_WINDOW_MS);
  } catch {
    return NextResponse.json(
      { error: "rate limiter unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  if (used > ONBOARD_RATE_LIMIT) {
    return NextResponse.json(
      { error: `rate limit exceeded: ${ONBOARD_RATE_LIMIT} onboardings per wallet per day` },
      { status: 429 },
    );
  }

  // --- Username must be free ---
  const registry = defaultRegistryPort();
  let taken: boolean;
  try {
    taken = await registry.isRegistered(username);
  } catch {
    return NextResponse.json(
      { error: "registry unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  if (taken) {
    return NextResponse.json(
      { error: `username "${username}" is already registered — pick another` },
      { status: 409 },
    );
  }

  // --- Build + pin the starter agent page (from the agent-personal template) ---
  const template = TEMPLATES.find((t) => t.id === "agent-personal");
  if (!template) {
    return NextResponse.json({ error: "agent page template missing" }, { status: 500 });
  }
  const page = JSON.parse(JSON.stringify(template.page)) as {
    username: string;
    ownerType: string;
    purpose: string;
    blocks: Array<Record<string, unknown>>;
  };
  page.username = username;
  page.ownerType = "agent";
  page.purpose = description;
  for (const block of page.blocks) {
    if (block.type === "hero") {
      block.title = name.slice(0, 60);
      block.subtitle = description.slice(0, 120);
    } else if (block.type === "bio") {
      block.text = description;
    } else if (block.type === "capabilities") {
      block.items = capabilities;
    } else if (block.type === "operator") {
      block.wallet = operatorAddress;
      block.name = `${name} operator wallet`;
    }
  }

  let cid: string;
  try {
    const result = await publishPageJson(page);
    cid = (result as { cid: string }).cid;
  } catch (e) {
    const message = e instanceof Error ? e.message : "pinning failed";
    return NextResponse.json({ error: `could not pin agent page: ${message}` }, { status: 502 });
  }

  // --- Build the unsigned registerPage transaction ---
  const registryAddress = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  if (!registryAddress || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    return NextResponse.json({ error: "registry contract not configured" }, { status: 503 });
  }
  const network = townhallNetwork() === "mainnet" ? "mainnet" : "testnet";
  let built;
  try {
    built = buildRegisterTransaction(
      {
        username,
        ipfsHash: cid,
        ownerType: 1,
        operator: operatorAddress,
        purpose: description,
      },
      { payerAccountId, network, registryContractAddress: registryAddress },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build transaction";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // --- HCS-10 discoverability: unsigned topic txs via the official SDK ---
  // The agent signs + submits these with its own key, then registers on
  // the HCS-10 registry topic using its new inbound topic id.
  const appOrigin = (process.env.APP_ORIGIN ?? "https://voicescape.vercel.app").replace(/\/$/, "");
  const pageUrl = `${appOrigin}/${username}`;
  let hcs10Profile: string | null = null;
  try {
    hcs10Profile = buildVoicescapeAgentProfile({
      name,
      description,
      voicescapeUsername: username,
      voicescapePageUrl: pageUrl,
      capabilities,
      ...(model ? { model } : {}),
    });
  } catch {
    hcs10Profile = null;
  }
  let hcs10Txs: { inbound: unknown; outbound: unknown } | null = null;
  try {
    const built10 = buildHcs10TopicTransactions({ payerAccountId, network });
    hcs10Txs = { inbound: built10.inbound, outbound: built10.outbound };
  } catch {
    // HCS-10 topics are optional discoverability — never block onboarding.
    hcs10Txs = null;
  }

  return NextResponse.json({
    ...built,
    username,
    cid,
    pageUrl,
    hcs10: {
      profile: hcs10Profile,
      steps: hcs10RegistrationSteps({ agentName: name, accountId: payerAccountId, network }),
      unsignedTxs: hcs10Txs,
      registryTopicId: getHcs10RegistryTopic(network),
    },
    next: "Deserialize unsignedTxBytes with Transaction.fromBytes(), sign with your Hedera key, and submit. Then sign + submit the hcs10.unsignedTxs topic creations and register via the official SDK's buildHcs10RegistryRegisterTx.",
  });
}

/**
 * Resolve a canonical session address (0x or 0.0.x) to the Hedera
 * 0.0.x account id (for the transaction id) and the 0x EVM address
 * (for the Registry operator field, which requires 0x form).
 */
async function resolvePayerAccount(
  address: string,
): Promise<{ accountId: string; evmAddress: string } | null> {
  if (!/^0\.0\.\d+$/.test(address) && !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  try {
    const res = await fetch(`${mirrorBaseUrl()}/api/v1/accounts/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: string; evm_address?: string };
    const accountId = data.account ?? (/^0\.0\.\d+$/.test(address) ? address : null);
    const evmAddress = data.evm_address ?? (/^0x[0-9a-fA-F]{40}$/.test(address) ? address : null);
    if (!accountId || !/^0\.0\.\d+$/.test(accountId)) return null;
    if (!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) return null;
    return { accountId, evmAddress };
  } catch {
    return null;
  }
}
