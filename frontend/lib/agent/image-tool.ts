/**
 * Buddy's image tool: `generate_page_image`.
 *
 * Lets Buddy create the artwork for a visitor's blockpage (avatar, banner,
 * background) from a text prompt. Generation runs through a free,
 * keyless image service (Pollinations) so the $0-operating-cost rule
 * holds; the bytes are validated server-side (real image magic bytes,
 * size cap) and then pinned to IPFS via Pinata, so the page references
 * permanent content-addressed URLs — never a hotlink.
 *
 * This is NOT a Hedera Agent Kit chain tool: it has no chain access, no
 * client, and no keys — it cannot sign, spend, or publish anything. It
 * only creates images. Abuse is bounded by a per-IP daily quota
 * (BUDDY_IMAGE_DAILY_QUOTA, default 3).
 *
 * Safety notes:
 * - The prompt is model-written from visitor input. The system prompt
 *   instructs wholesome, family-friendly prompts with no real people;
 *   Pollinations applies its own moderation layer on top.
 * - Filenames are neutral and server-chosen — nothing user-controlled
 *   reaches Pinata metadata.
 */
import { TOOL_TYPE, type Tool } from "@hashgraph/hedera-agent-kit";
import { z } from "zod";
import { MAX_IMAGE_BYTES, publishImageFile } from "@/lib/server/publish.js";
import { globalQuotaStore, quotaLimitFromEnv } from "@/lib/server/quota";

export const GENERATE_IMAGE_TOOL = "generate_page_image";

const imageParamsSchema = z.object({
  kind: z
    .enum(["avatar", "banner", "background"])
    .describe(
      "Which artwork to create: avatar (square profile picture), " +
        "banner (wide header image), or background (page backdrop)."
    ),
  prompt: z
    .string()
    .min(8)
    .max(500)
    .describe(
      "Vivid, wholesome, family-friendly image prompt describing the " +
        "artwork. No real people, no text or words in the image, no logos. " +
        "Describe style, colors, mood, and subject."
    ),
});

type ImageParams = z.infer<typeof imageParamsSchema>;

const DIMENSIONS: Record<ImageParams["kind"], { width: number; height: number }> = {
  avatar: { width: 1024, height: 1024 },
  banner: { width: 1600, height: 900 },
  background: { width: 1280, height: 720 },
};

/** True when the bytes are a real JPEG, PNG, WebP, or GIF image. */
function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return true;
  // WebP: RIFF .... WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return true;
  // GIF: GIF8
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return true;
  return false;
}

function gatewayUrl(cid: string): string {
  const raw = (process.env.IPFS_GATEWAY ?? "ipfs.io")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  // An env var that is set-but-empty would otherwise produce the broken
  // "https:///ipfs/<cid>" — fall back to the public gateway instead.
  const host = raw || "ipfs.io";
  return `https://${host}/ipfs/${cid}`;
}

/**
 * Build the image tool for one request. The visitor's IP is bound in so
 * the per-IP daily quota applies to anonymous chat users.
 */
export function makeImageTool(clientIp: string): Tool {
  return {
    method: GENERATE_IMAGE_TOOL,
    name: "Generate Page Image",
    description:
      "Generate artwork for the visitor's blockpage: avatar, banner, or " +
      "background. Returns a permanent IPFS URL to use in the page. " +
      "Wholesome, family-friendly prompts only — no real people, no text " +
      "or logos in the image. At most 3 images per visitor per day; if the " +
      "tool reports the quota is reached, tell the visitor plainly and " +
      "continue without more images. Read-only w.r.t. the chain: creates " +
      "images only, never signs, spends, or publishes.",
    parameters: imageParamsSchema,
    toolType: TOOL_TYPE.QUERY,
    execute: async (_client, ctx, params) => {
      const signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
      const { kind, prompt } = imageParamsSchema.parse(params);

      // Sanitize the model-written prompt: printable chars, length-capped.
      const cleanPrompt = prompt.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500);
      if (cleanPrompt.length < 8) {
        return JSON.stringify({ error: "prompt too short after sanitizing" });
      }
      const { width, height } = DIMENSIONS[kind];
      const seed = Math.floor(Math.random() * 1_000_000);
      const genUrl =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}` +
        `?width=${width}&height=${height}&nologo=true&model=flux&seed=${seed}`;

      let res;
      try {
        res = await fetch(genUrl, {
          signal,
          headers: { "user-agent": "VoicescapeAgent/1.0 (+https://voicescape.vercel.app)" },
        });
      } catch (e) {
        return JSON.stringify({
          error: `image service unreachable: ${e instanceof Error ? e.message : String(e).slice(0, 120)}`,
        });
      }
      if (!res.ok) {
        return JSON.stringify({ error: `image service returned HTTP ${res.status}` });
      }
      const contentType = res.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!contentType.startsWith("image/") || !isImageBytes(bytes)) {
        return JSON.stringify({ error: "image service did not return a valid image" });
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return JSON.stringify({ error: "generated image too large" });
      }

      // Per-IP daily quota, consumed only once the art service actually
      // delivered valid image bytes: a timed-out or errored generation must
      // not eat the visitor's daily budget (a paid build needs all 3).
      // Pinning (the real platform cost) stays behind the quota gate.
      const limit = quotaLimitFromEnv("BUDDY_IMAGE_DAILY_QUOTA", 3);
      let quota;
      try {
        quota = await globalQuotaStore().consume("buddy:image", clientIp, limit);
      } catch (e) {
        return JSON.stringify({
          error: `image quota store unreachable: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      if (!quota.allowed) {
        return JSON.stringify({
          error: `daily image limit reached (${limit}/day) — try again tomorrow`,
        });
      }

      const mime = contentType.split(";")[0].trim() || "image/jpeg";
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      const filename = `buddy-${kind}-${Date.now()}.${ext}`;
      try {
        const { cid } = await publishImageFile(bytes, filename, mime);
        return JSON.stringify({ kind, cid, url: gatewayUrl(cid) });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return JSON.stringify({
          error: message.includes("PINATA_UNAVAILABLE")
            ? "image pinning temporarily unavailable"
            : `image pinning failed: ${message.slice(0, 120)}`,
        });
      }
    },
  };
}

