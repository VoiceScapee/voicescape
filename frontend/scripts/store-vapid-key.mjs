/**
 * Store the VAPID *private* key for web-push in the shared KV store.
 *
 *   PUSH_VAPID_PRIVATE_KEY=<private-key> npx tsx scripts/store-vapid-key.mjs
 *
 * Writes key "push:vapid:private" with a 10-year TTL via getKvStore().set().
 * The private key is NEVER committed to code or git — it travels only in
 * the PUSH_VAPID_PRIVATE_KEY environment variable, which the operator sets
 * for this one command.
 *
 * Run with tsx (this file is .mjs but imports the TypeScript store module):
 *   cd frontend && PUSH_VAPID_PRIVATE_KEY=... npx tsx scripts/store-vapid-key.mjs
 */
import { getKvStore, storeBackendKind } from "../lib/server/store.js";
import { PUSH_VAPID_KV_KEY, PUSH_VAPID_TTL_MS } from "../lib/server/push.js";
import { isValidVapidPrivateKey } from "../lib/push.js";

const key = (process.env.PUSH_VAPID_PRIVATE_KEY ?? "").trim();

if (!isValidVapidPrivateKey(key)) {
  console.error(
    "[store-vapid-key] PUSH_VAPID_PRIVATE_KEY is missing or malformed " +
      "(expected 43 URL-safe base64 chars). Nothing was written.",
  );
  process.exit(1);
}

const store = getKvStore();
await store.set(PUSH_VAPID_KV_KEY, key, PUSH_VAPID_TTL_MS);
const check = await store.get(PUSH_VAPID_KV_KEY);
if (check !== key) {
  console.error("[store-vapid-key] write verification failed — key not readable back.");
  process.exit(1);
}
console.log(
  `[store-vapid-key] wrote "${PUSH_VAPID_KV_KEY}" to the ${storeBackendKind()} store (10-year TTL).`,
);
