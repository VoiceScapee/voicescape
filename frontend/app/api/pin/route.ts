import { NextRequest, NextResponse } from "next/server";
// Server-only: the Pinata JWT must never reach the browser.
import { publishAudioFile, publishPageJson } from "../../../lib/server/publish.js";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { agentQuotaKey, requireAgentScopeForUsername } from "@/lib/server/townhall/agent-scope";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { ipGate } from "@/lib/server/rate-limit";
import { validateAudioUpload } from "@/lib/server/media-safety";
import { checkPageJson } from "@/lib/server/townhall/content-filter";
import { isValidPage } from "@/lib/schema";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";

/** Best-effort server-error aggregate for JSON-pin failures. Never throws. */
async function trackPin(code: string): Promise<void> {
  try {
    await recordClientError(getKvStore(), "/api/pin", code, "server", null, Date.now(), {
      action: code,
    });
  } catch {
    /* tracking never blocks the response */
  }
}

export const runtime = "nodejs";

/**
 * Privacy: the upload filename is fully user-controlled and persists in
 * Pinata metadata. Replace it with a neutral name — PII like
 * "john-smith-555-1234.mp3" must never reach storage. Only the safe
 * audio extension is preserved.
 */
function safeAudioFilename(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "";
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = "bin";
  return `audio-${Date.now()}.${ext}`;
}

/**
 * POST /api/pin — pin to IPFS via Pinata. Two modes:
 *
 * 1. JSON body → pins a Voicescape page document (existing behavior).
 *    Returns { cid, provider }.
 * 2. multipart/form-data with a "file" field → pins a user-uploaded audio
 *    file ("upload your own music"). The server re-validates MIME + size.
 *    Returns { cid, provider }.
 */
export async function POST(req: NextRequest) {
  // Per-IP flood bound in front of the per-wallet pin quotas.
  const gated = await ipGate(
    req,
    "pin",
    "IP_RATE_LIMIT_PIN",
    120,
    "too many pin requests from this network — try again later",
  );
  if (gated) return gated;

  // Pinning is a write: require a signed-in wallet session. The credential
  // travels in the x-vs-session header (works for JSON and multipart).
  // Agent tokens are accepted ONLY for JSON page-doc pins scoped to the
  // token's own agent username (enforced below); everything else about
  // this route stays human-only via the fail-closed port default.
  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req), {
    allowAgent: true,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const session = verified.session;

  const contentType = req.headers.get("content-type") ?? "";
  const wallet = session.address.toLowerCase();
  // Agent-token writes count against the agent's own quota bucket — never
  // the human's — so a rogue or buggy agent cannot burn the human's
  // pin allowance (or the operator's Pinata funds).
  const quotaKey = agentQuotaKey(session) ?? wallet;
  const isAgent = agentQuotaKey(session) !== null;

  if (contentType.includes("multipart/form-data")) {
    // Audio uploads are human-only in v1: an agent token may only pin its
    // own page document (JSON below). The human can upload the agent's
    // profile audio from their own session.
    if (isAgent) {
      return NextResponse.json(
        { error: "agent tokens can only pin page documents, not audio files" },
        { status: 403 },
      );
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Expected a "file" field in the multipart body.' },
        { status: 400 },
      );
    }
    // Pinning costs real Pinata allowance (25 MB each for audio — the
    // expensive one): per-wallet daily quota, checked after session verify
    // and before any pinning. AUDIO_DAILY_QUOTA default 3.
    const audioLimit = quotaLimitFromEnv("AUDIO_DAILY_QUOTA", 3);
    let audioQ;
    try {
      audioQ = await globalQuotaStore().consume("pin:audio", wallet, audioLimit);
    } catch (e) {
      // Quota store unreachable: fail CLOSED (503) — unchecked pinning
      // could burn the Pinata free-tier allowance.
      console.error(`[pin] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json(
        { error: "temporarily unavailable — please retry in a moment" },
        { status: 503 },
      );
    }
    if (!audioQ.allowed) {
      console.warn(
        `[quota] pin:audio: wallet ${verified.session.address} hit daily limit ${audioLimit}`,
      );
      return NextResponse.json(
        quotaExceededBody(audioQ, `daily audio pin limit reached (${audioLimit}/day)`),
        { status: 429 },
      );
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Defense-in-depth: verify the actual bytes are audio (magic bytes),
      // not just the client-declared Content-Type. A disguised executable
      // or image can't pass this check.
      const screen = validateAudioUpload(bytes, file.type);
      if (!screen.ok) {
        return NextResponse.json({ error: screen.reason }, { status: 400 });
      }
      const { cid, provider } = await publishAudioFile(bytes, safeAudioFilename(file.name), file.type);
      return NextResponse.json({ cid, provider });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const pinataDown = message.includes("PINATA_UNAVAILABLE");
      if (pinataDown) {
        console.error("[pin] Pinata unavailable (audio): publishing service misconfigured or down");
      }
      const status = pinataDown
        ? 503
        : message.includes("too large") || message.includes("non-audio")
          ? 400
          : 502;
      // User-facing copy: no env var names, no config URLs. The draft is
      // safe in the builder's local state — the user can retry later.
      const userMessage = pinataDown
        ? "Publishing is temporarily unavailable — your work is saved, please try again later."
        : message;
      return NextResponse.json({ error: userMessage }, { status });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Agent scope: the pinned page document must belong to the token's own
  // agent username. Checked before quota so a rejected scope never burns
  // anyone's allowance.
  if (isAgent) {
    const pageUsername =
      typeof body === "object" && body !== null
        ? (body as { username?: unknown }).username
        : undefined;
    const gate = requireAgentScopeForUsername(session, pageUsername);
    if (!gate.ok) {
      await trackPin("scope-rejected");
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }
  }

  // JSON pins are cheap per call but the Pinata free allowance is finite:
  // per-wallet daily quota before pinning. PIN_DAILY_QUOTA default 20.
  // Agent tokens draw from their own bucket (quotaKey), never the human's.
  const pinLimit = quotaLimitFromEnv("PIN_DAILY_QUOTA", 20);
  let pinQ;
  try {
    pinQ = await globalQuotaStore().consume("pin:json", quotaKey, pinLimit);
  } catch (e) {
    // Quota store unreachable: fail CLOSED (503).
    console.error(`[pin] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    await trackPin("quota-store-down");
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
  if (!pinQ.allowed) {
    console.warn(
      `[quota] pin:json: wallet ${verified.session.address} hit daily limit ${pinLimit}`,
    );
    await trackPin("quota-exceeded");
    return NextResponse.json(
      quotaExceededBody(pinQ, `daily page pin limit reached (${pinLimit}/day)`),
      { status: 429 },
    );
  }

  try {
    // Privacy: the page JSON is immutable on IPFS — reject any PII
    // (phone/email), illegal, or sexually explicit adult content in bios,
    // titles, or text blocks before pinning (and before the wallet signs).
    const piiBlock = checkPageJson(body);
    if (piiBlock) {
      await trackPin("content-blocked");
      return NextResponse.json({ error: piiBlock }, { status: 400 });
    }
    // Schema: a JSON pin is always a Voicescape page document. Reject
    // anything the page renderer would refuse to display — pinning an
    // invalid page mints a permanent, unloadable IPFS object (this bit
    // us on /forge, whose hand-written JSON was missing its theme).
    // User-facing copy: no schema jargon.
    if (!isValidPage(body)) {
      await trackPin("invalid-page");
      return NextResponse.json(
        { error: "This page can't be published because something's missing. Please rebuild it in the builder and try again." },
        { status: 400 },
      );
    }
    const { cid, provider } = await publishPageJson(body);
    return NextResponse.json({ cid, provider });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const pinataDown = message.includes("PINATA_UNAVAILABLE");
    if (pinataDown) {
      console.error("[pin] Pinata unavailable (page JSON): publishing service misconfigured or down");
    }
    const status = pinataDown
      ? 503
      : message.includes("page JSON too large")
        ? 413
        : 502;
    await trackPin(pinataDown ? "pinata-down" : status === 413 ? "page-too-large" : "pin-failed");
    // User-facing copy: no env var names, no config URLs. The draft is
    // safe in the builder's local state — the user can retry later.
    const userMessage = pinataDown
      ? "Publishing is temporarily unavailable — your work is saved, please try again later."
      : message;
    return NextResponse.json({ error: userMessage }, { status });
  }
}
