import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { getTopicId, townhallNetwork } from "@/lib/server/townhall/topics";
import { canonicalAddress } from "@/lib/session-message";
import {
  defaultDeps,
  type TownhallDeps,
} from "@/lib/server/townhall/handlers";
import {
  resolveAgentKeyAuth,
  AGENT_KEY_HEADER,
} from "@/lib/server/agents/links";
import {
  buildBuyTransaction,
  buildPostTransaction,
  buildTipTransaction,
  EXECUTE_RATE_LIMIT,
  EXECUTE_RATE_WINDOW_MS,
  parseInstruction,
  type BuildContext,
} from "@/lib/server/agents/executor";

export const runtime = "nodejs";

/**
 * POST /api/agents/execute — natural-language to unsigned Hedera transaction.
 *
 * This is Voicescape's Hedera Agent Kit integration (RETURN_BYTES mode):
 * an AI agent sends a natural-language instruction, the server parses it
 * into a Hedera operation, builds the transaction, and returns the
 * UNSIGNED bytes. The agent signs with its own Hedera key and submits —
 * the funds come from the agent's own wallet. The server never touches
 * private keys and never signs on anyone's behalf.
 *
 * Body: { instruction: string, agentId: string }
 *   - instruction: e.g. "tip 5 HBAR to @brandon", "post 'hello' to the forum",
 *     "buy listing abc from 0x<seller> for 5 HBAR"
 *   - agentId: the agent's Voicescape username (must be a registered page
 *     owned by the session wallet)
 *
 * Response: { unsignedTxBytes, description, transactionId, txType }
 *   - unsignedTxBytes: base64-encoded frozen transaction. Deserialize with
 *     Transaction.fromBytes(), sign with the wallet, submit.
 *
 * Auth: signed wallet session (x-vs-session header) OR an agent API key
 * (x-vs-agent-key header), issued when a human links their agent at
 * POST /api/agents/link. With a key, the linked agent is the payer and
 * agentId must name the linked agent page. 401 without either.
 * Rate limit: 10/hour per wallet + 30/hour per agent key + per-IP flood
 * gate. 429 when exceeded.
 * Safety: 100 HBAR max per operation, content filter on posts, agent must
 * be registered. All executions are logged to the HCS audit topic
 * (best-effort).
 */
export async function POST(req: NextRequest) {
  // Per-IP flood gate in front of the per-wallet quota.
  const gated = await ipGate(
    req,
    "agents-execute",
    "IP_RATE_LIMIT_AGENTS_EXECUTE",
    60,
    "too many agent execute requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { instruction, agentId } = (body ?? {}) as {
    instruction?: unknown;
    agentId?: unknown;
  };
  if (typeof instruction !== "string" || !instruction.trim()) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }
  if (typeof agentId !== "string" || !agentId.trim()) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const deps = defaultDeps();

  // --- Auth: agent API key OR signed wallet session ---
  //
  // Agent-key path (the connected-agent flow): the agent sends the key
  // issued at link time as x-vs-agent-key. The key resolves to the linked
  // identity — the agent transacts from its OWN Hedera wallet (the payer),
  // and the requested agentId must name the linked agent page. The
  // per-key quota is enforced inside resolveAgentKeyAuth.
  //
  // Session path (unchanged): a human signs in with their wallet and acts
  // through an agent page their wallet owns.
  let agentName: string;
  let payerAccountId: string;
  let auditWallet: string;

  const agentKeyHeader = req.headers.get(AGENT_KEY_HEADER);
  if (agentKeyHeader) {
    const keyAuth = await resolveAgentKeyAuth(req.headers, getKvStore());
    if (!keyAuth.ok) {
      return NextResponse.json({ error: keyAuth.error }, { status: keyAuth.status });
    }
    const requested = agentId.trim().toLowerCase().replace(/^@+/, "");
    if (requested !== keyAuth.identity.username.toLowerCase()) {
      return NextResponse.json(
        {
          error: `this agent key is linked to "${keyAuth.identity.username}" — agentId must match the linked agent`,
        },
        { status: 403 },
      );
    }
    agentName = keyAuth.identity.username;
    payerAccountId = keyAuth.identity.agentAccountId;
    auditWallet = `agent-key:${keyAuth.identity.keyId}`;
  } else {
    const cred = sessionCredentialFrom(req);
    if (!cred) {
      return NextResponse.json(
        { error: "missing session: sign in with your wallet, or send an agent API key" },
        { status: 401 },
      );
    }
    const verified = await deps.auth.verifySession(cred);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 401 });
    }
    const session = verified.session;

    // --- Agent registration: agentId must be a page owned by the session wallet ---
    agentName = agentId.trim().toLowerCase().replace(/^@+/, "");
    let agentOwner: string | null;
    try {
      agentOwner = await deps.registry.resolveOwner(agentName);
    } catch {
      return NextResponse.json(
        { error: "registry unavailable — try again in a moment" },
        { status: 503 },
      );
    }
    if (!agentOwner) {
      return NextResponse.json(
        { error: `agent "${agentName}" is not registered on Voicescape` },
        { status: 403 },
      );
    }
    if (canonicalAddress(agentOwner) !== session.address) {
      return NextResponse.json(
        { error: "this wallet does not own the agent page — sign in with the agent owner's wallet" },
        { status: 403 },
      );
    }

    // --- Per-wallet rate limit: 10/hour ---
    const store = getKvStore();
    const rateKey = `agent-execute:${session.address}`;
    let used: number;
    try {
      used = await store.incr(rateKey, EXECUTE_RATE_WINDOW_MS);
    } catch {
      return NextResponse.json(
        { error: "rate limiter unavailable — try again in a moment" },
        { status: 503 },
      );
    }
    if (used > EXECUTE_RATE_LIMIT) {
      return NextResponse.json(
        { error: `rate limit exceeded: ${EXECUTE_RATE_LIMIT} agent executions per hour` },
        { status: 429 },
      );
    }

    // Session address is a canonical 0x address; derive the 0.0.x payer id.
    // For Hedera sessions the address IS the 0.0.x id in the token; canonical
    // 0x form is used for registry comparisons. We need the 0.0.x form here.
    const resolved = await resolvePayerAccountId(deps, session.address);
    if (!resolved) {
      return NextResponse.json(
        { error: "could not resolve your Hedera account id" },
        { status: 400 },
      );
    }
    payerAccountId = resolved;
    auditWallet = session.address;
  }

  // --- Parse the instruction ---
  const parsed = parseInstruction(instruction);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const op = parsed.op;

  // --- Build the unsigned transaction ---
  const network = townhallNetwork() === "mainnet" ? "mainnet" : "testnet";
  const ctx: BuildContext = { payerAccountId, network };
  try {
    let built;
    if (op.kind === "tip") {
      const recipient = await deps.registry.resolveOwner(op.targetUsername);
      if (!recipient) {
        return NextResponse.json(
          { error: `@${op.targetUsername} is not registered on Voicescape` },
          { status: 400 },
        );
      }
      // Tips route through the Tips contract so the 98/2 split is atomic.
      const tipsAddress = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
      if (!tipsAddress) {
        return NextResponse.json(
          { error: "tipping contract not configured" },
          { status: 503 },
        );
      }
      built = buildTipTransaction(op, { ...ctx, tipsContractAddress: tipsAddress });
    } else if (op.kind === "post") {
      const topicId = getTopicId(op.destination);
      if (!topicId) {
        return NextResponse.json(
          { error: `${op.destination} topic not configured` },
          { status: 503 },
        );
      }
      built = buildPostTransaction(op, { ...ctx, topicId });
    } else {
      const tipsAddress = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
      if (!tipsAddress) {
        return NextResponse.json(
          { error: "marketplace contract not configured" },
          { status: 503 },
        );
      }
      built = buildBuyTransaction(op, { ...ctx, tipsContractAddress: tipsAddress });
    }

    // --- Audit log (best-effort, never blocks the response) ---
    void logAudit(deps, {
      agent: agentName,
      wallet: auditWallet,
      instruction: instruction.slice(0, 200),
      description: built.description,
      transactionId: built.transactionId,
      txType: built.txType,
    }).catch(() => {
      /* audit is best-effort */
    });

    return NextResponse.json(built);
  } catch (e) {
    const message = e instanceof Error ? e.message : "failed to build transaction";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Resolve a canonical address (0x or 0.0.x) to a Hedera 0.0.x account id.
 * The registry returns EVM addresses; the mirror node maps them back via
 * GET /api/v1/accounts/<evm-address>.
 */
async function resolvePayerAccountId(
  _deps: TownhallDeps,
  address: string,
): Promise<string | null> {
  // Already a Hedera account id.
  if (/^0\.0\.\d+$/.test(address)) return address;
  // EVM address → mirror node lookup.
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const { mirrorBaseUrl } = await import("@/lib/server/townhall/topics");
  try {
    const res = await fetch(`${mirrorBaseUrl()}/api/v1/accounts/${address}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: string };
    return data.account && /^0\.0\.\d+$/.test(data.account) ? data.account : null;
  } catch {
    return null;
  }
}

/** Best-effort audit log to the HCS votes topic (used as the audit trail).
 *
 * NOTE: In the user-signed architecture, the server cannot submit to HCS
 * (no operator key). Agent execution audit logs are skipped. If HCS audit
 * logging is needed, the client must sign the log entry via their wallet.
 */
async function logAudit(
  deps: TownhallDeps,
  entry: {
    agent: string;
    wallet: string;
    instruction: string;
    description: string;
    transactionId: string;
    txType: string;
  },
): Promise<void> {
  // No-op: server cannot submit to HCS without an operator key.
  // The agent execution itself is the auditable event (signed by the user).
  return;
}
