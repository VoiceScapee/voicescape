import { NextRequest, NextResponse } from "next/server";
import { publishDigitalGood, MAX_DIGITAL_GOOD_BYTES } from "@/lib/server/publish.js";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { globalQuotaStore, quotaExceededBody, quotaLimitFromEnv } from "@/lib/server/quota";
import { ipGate } from "@/lib/server/rate-limit";
import { sniffMediaKind } from "@/lib/server/media-safety";

export const runtime = "nodejs";

/**
 * Privacy: the upload filename is fully user-controlled. Replace it with a
 * neutral name — PII must never reach storage. Only a safe extension is kept.
 */
function safeGoodFilename(raw: unknown, kind: string): string {
  const name = typeof raw === "string" ? raw : "";
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = { pdf: "pdf", zip: "zip" }[kind] ?? "bin";
  return `digital-good-${Date.now()}.${ext}`;
}

/** True for the file kinds a marketplace digital good may be. */
function sniffGoodKind(bytes: Uint8Array): "image" | "pdf" | "zip" | null {
  const kind = sniffMediaKind(bytes);
  if (kind === "jpeg" || kind === "png" || kind === "gif" || kind === "webp") return "image";
  // PDF: %PDF- ; ZIP: PK\x03\x04 (also covers docx/epub, which are zips)
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  return null;
}

/**
 * POST /api/townhall/market/upload — pin a marketplace digital-good file to
 * IPFS via Pinata. multipart/form-data with a "file" field.
 * Returns { cid, kind } — the seller binds the CID into their listing.
 *
 * Session-required (x-vs-session header). Per-wallet daily quota
 * (DIGITAL_GOOD_DAILY_QUOTA, default 5) so one seller can't burn the
 * Pinata allowance. 10 MB cap; images / PDF / ZIP only, verified by magic
 * bytes — a disguised executable can't pass.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(req, "townhall", "IP_RATE_LIMIT_TOWNHALL", 300, "too many requests from this network — try again later");
  if (gated) return gated;

  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req), {});
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const wallet = verified.session.address.toLowerCase();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Expected a "file" field in the multipart body.' }, { status: 400 });
  }

  const limit = quotaLimitFromEnv("DIGITAL_GOOD_DAILY_QUOTA", 5);
  let q;
  try {
    q = await globalQuotaStore().consume("pin:digital-good", wallet, limit);
  } catch (e) {
    console.error(`[market-upload] quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "temporarily unavailable — please retry in a moment" }, { status: 503 });
  }
  if (!q.allowed) {
    return NextResponse.json(quotaExceededBody(q, `daily digital-good upload limit reached (${limit}/day)`), { status: 429 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
  if (bytes.length > MAX_DIGITAL_GOOD_BYTES) {
    return NextResponse.json({ error: `file too large (max ${MAX_DIGITAL_GOOD_BYTES / 1024 / 1024} MB)` }, { status: 400 });
  }
  const kind = sniffGoodKind(bytes);
  if (!kind) {
    return NextResponse.json(
      { error: "unsupported file type — digital goods must be an image (JPEG/PNG/GIF/WebP), PDF, or ZIP" },
      { status: 400 },
    );
  }
  const mime = kind === "image" ? (file.type.startsWith("image/") ? file.type : "application/octet-stream")
    : kind === "pdf" ? "application/pdf"
    : "application/zip";
  try {
    const { cid } = await publishDigitalGood(bytes, safeGoodFilename(file.name, kind), mime);
    return NextResponse.json({ cid, kind });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "PINATA_UNAVAILABLE") {
      return NextResponse.json({ error: "file pinning is temporarily unavailable" }, { status: 503 });
    }
    console.error(`[market-upload] pin failed: ${msg}`);
    return NextResponse.json({ error: "file upload failed — try again in a moment" }, { status: 502 });
  }
}
