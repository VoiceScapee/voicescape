import { NextRequest, NextResponse } from "next/server";
// Server-only: the Pinata JWT must never reach the browser.
import { publishAudioFile, publishPageJson } from "../../../lib/server/publish.js";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { ipGate } from "@/lib/server/rate-limit";
import { validateAudioUpload } from "@/lib/server/media-safety";
import { checkContent } from "@/lib/server/townhall/content-filter";

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
 * Privacy: blockpage JSON is pinned to IPFS, which is immutable — a phone
 * number in a bio could never be taken back. Recursively walk every
 * string value and run it through the content filter. Returns the block
 * reason when PII/unsafe content is found, null when clean.
 */
function pageJsonPiiCheck(value: unknown, seen = new Set<object>()): string | null {
  if (typeof value === "string") {
    const check = checkContent(value, "page content");
    return check.allowed ? null : (check.reason ?? "content blocked");
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return null; // cycle guard
    seen.add(value);
    const vals = Array.isArray(value) ? value : Object.values(value);
    for (const v of vals) {
      const hit = pageJsonPiiCheck(v, seen);
      if (hit) return hit;
    }
  }
  return null;
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
  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  const wallet = verified.session.address.toLowerCase();

  if (contentType.includes("multipart/form-data")) {
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

  // JSON pins are cheap per call but the Pinata free allowance is finite:
  // per-wallet daily quota before pinning. PIN_DAILY_QUOTA default 20.
  const pinLimit = quotaLimitFromEnv("PIN_DAILY_QUOTA", 20);
  let pinQ;
  try {
    pinQ = await globalQuotaStore().consume("pin:json", wallet, pinLimit);
  } catch (e) {
    // Quota store unreachable: fail CLOSED (503).
    console.error(`[pin] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
  if (!pinQ.allowed) {
    console.warn(
      `[quota] pin:json: wallet ${verified.session.address} hit daily limit ${pinLimit}`,
    );
    return NextResponse.json(
      quotaExceededBody(pinQ, `daily page pin limit reached (${pinLimit}/day)`),
      { status: 429 },
    );
  }

  try {
    // Privacy: the page JSON is immutable on IPFS — reject any PII
    // (phone/email) in bios, titles, or text blocks before pinning.
    const piiBlock = pageJsonPiiCheck(body);
    if (piiBlock) {
      return NextResponse.json({ error: piiBlock }, { status: 400 });
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
    // User-facing copy: no env var names, no config URLs. The draft is
    // safe in the builder's local state — the user can retry later.
    const userMessage = pinataDown
      ? "Publishing is temporarily unavailable — your work is saved, please try again later."
      : message;
    return NextResponse.json({ error: userMessage }, { status });
  }
}
