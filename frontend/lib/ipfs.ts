/**
 * IPFS helpers (browser-safe).
 *
 * Pinning goes through the server-side /api/pin route (which holds the
 * Pinata JWT) — the key never reaches the browser. Fetching reads straight
 * from a public gateway.
 */
import { getAuthHeaders } from "./auth-client";

function getGateway(): string {
  const gw = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";
  return gw.endsWith("/") ? gw : `${gw}/`;
}

/**
 * Pin page JSON to IPFS via the /api/pin server route.
 * Returns the resulting CID.
 */
export async function pinPageJson(pageJson: string): Promise<string> {
  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { "content-type": "application/json", ...getAuthHeaders() },
    body: pageJson,
  });
  const data = (await res.json().catch(() => ({}))) as { cid?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Pinning failed (HTTP ${res.status}).`);
  }
  if (!data.cid) {
    throw new Error("Pinning succeeded but the server returned no CID.");
  }
  return data.cid;
}

/**
 * Fetch page JSON from IPFS by hash/CID.
 */export async function fetchPageJson(ipfsHash: string): Promise<string> {
  // KISS: try multiple gateways — ipfs.io rate-limits aggressively.
  const gateways = [
    getGateway(),
    "https://cloudflare-ipfs.com/ipfs/",
    "https://gateway.pinata.cloud/ipfs/",
  ];
  let lastError: Error | null = null;
  for (const gw of gateways) {
    try {
      const url = `${gw}${ipfsHash}`;
      const res = await fetch(url);
      if (!res.ok) {
        lastError = new Error(`IPFS fetch failed (${res.status}) for ${ipfsHash}`);
        continue;
      }
      const text = await res.text();
      // Gateway returned HTML (error page) instead of JSON — try next.
      if (text.trimStart().startsWith("<")) {
        lastError = new Error(`IPFS gateway returned HTML for ${ipfsHash}`);
        continue;
      }
      return text;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error(`IPFS fetch failed for ${ipfsHash}`);
}

/** Max audio upload size: 25 MB (keeps pins cheap and gateway-friendly). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** Gateway URL for an audio CID pinned to IPFS. */
export function audioGatewayUrl(cid: string): string {
  return `${getGateway()}${cid}`;
}

/**
 * Upload the page owner's own audio file ("upload your own music").
 * Posts multipart/form-data to /api/pin, which pins via Pinata server-side
 * (the JWT never reaches the browser). Returns the audio CID.
 *
 * Client-side guardrails: must be an audio/* file under MAX_AUDIO_BYTES.
 * The server re-validates — never trust the client alone.
 */
export async function pinAudioFile(file: Blob, filename?: string): Promise<string> {
  const type = file.type || "";
  if (!type.startsWith("audio/")) {
    throw new Error(`Not an audio file (got "${type || "unknown type"}").`);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB; max 25 MB).`,
    );
  }
  const form = new FormData();
  const name = filename || (file instanceof File ? file.name : "upload.audio") || "upload.audio";
  form.append("file", file, name);

  const res = await fetch("/api/pin", {
    method: "POST",
    headers: { ...getAuthHeaders() },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { cid?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Audio upload failed (HTTP ${res.status}).`);
  }
  if (!data.cid) {
    throw new Error("Upload succeeded but the server returned no CID.");
  }
  return data.cid;
}
