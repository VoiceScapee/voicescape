/**
 * Voicescape — web push for tip notifications (Slice 1).
 *
 * Client-safe constants and helpers shared by the blockpage toggle and the
 * service worker registration flow.
 *
 * Security: ONLY the VAPID *public* key lives here. The private key is
 * never in code or git — it is self-generated on first use and persisted in
 * the server KV store (read server-side only).
 *
 * The authoritative public key is served by GET /api/push/vapid-public-key;
 * the constant below is only a FALLBACK for the rare case that endpoint is
 * unreachable (a rotated keypair would make the fallback stale, so the
 * endpoint is always tried first).
 */

/**
 * Fallback VAPID public key for push subscription (URL-safe base64, no
 * padding). Used only when /api/push/vapid-public-key is unreachable —
 * see the note above. The authoritative key always comes from the endpoint.
 */
export const PUSH_VAPID_PUBLIC_KEY =
  "BPXMSlVt7p4oeaxugnbpF_B0zKw7kkUYqIjQtKF4IjmEzQcg1dIkmSBO2cqyPKaHzBaJ2qvuCG0DAddppnKA_5c";

/**
 * VAPID public keys are 65-byte uncompressed EC points → 87 base64url chars
 * (no padding). Private keys are 32 bytes → 43 base64url chars.
 */
const B64URL = "[A-Za-z0-9_-]";
const VAPID_PUBLIC_RE = new RegExp(`^${B64URL}{87}$`);
const VAPID_PRIVATE_RE = new RegExp(`^${B64URL}{43}$`);

/** True when the value looks like a VAPID public key (format only). */
export function isValidVapidPublicKey(key: unknown): key is string {
  return typeof key === "string" && VAPID_PUBLIC_RE.test(key);
}

/** True when the value looks like a VAPID private key (format only). */
export function isValidVapidPrivateKey(key: unknown): key is string {
  return typeof key === "string" && VAPID_PRIVATE_RE.test(key);
}

/** PushSubscription keys as sent to /api/push/subscriptions. */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** BCP-47-ish language code, e.g. "en" — used to localize the push text. */
  lang?: string;
}

/**
 * Convert a URL-safe base64 VAPID key to the Uint8Array form the
 * PushManager wants. Throws on malformed input.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** localStorage key for the persisted per-wallet toggle state. */
export function pushToggleStorageKey(wallet: string): string {
  return `vs-push-tip-${wallet.toLowerCase()}`;
}
