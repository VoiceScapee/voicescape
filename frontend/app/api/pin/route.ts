import { NextRequest, NextResponse } from "next/server";
// Server-only: the Pinata JWT must never reach the browser.
import { publishAudioFile, publishPageJson } from "../../../lib/server/publish.js";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { ipGate } from "@/lib/server/rate-limit";
import { validateAudioUpload } from "@/lib/server/media-safety";

export const runtime = "nodejs";

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
      const { cid, provider } = await publishAudioFile(bytes, file.name, file.type);
      return NextResponse.json({ cid, provider });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = message.includes("PINATA_JWT is not set")
        ? 500
        : message.includes("too large") || message.includes("non-audio")
          ? 400
          : 502;
      return NextResponse.json({ error: message }, { status });
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
    const { cid, provider } = await publishPageJson(body);
    return NextResponse.json({ cid, provider });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = message.includes("PINATA_JWT is not set")
      ? 500
      : message.includes("page JSON too large")
        ? 413
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
