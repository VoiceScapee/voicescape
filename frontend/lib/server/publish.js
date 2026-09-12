/**
 * @fileoverview IPFS helper module for Project Voicescape (server-side).
 *
 * Publishes a Voicescape page's JSON content to IPFS via Pinata and fetches
 * it back from an IPFS gateway. The blockchain only stores the resulting CID
 * (username -> CID registry); all page content lives on IPFS.
 *
 * Pinning strategy: Pinata-only. The web3.storage legacy token API was
 * sunset (its successor Storacha uses UCAN auth + CAR uploads, a much bigger
 * integration); shipping an unverified fallback would be worse than none.
 *
 * Plain ESM JavaScript, zero runtime dependencies — uses global `fetch`
 * (Node 18+). Imported by the Next.js `/api/pin` route; also usable
 * standalone from Node scripts.
 *
 * @module @voicescape/ipfs
 */

/**
 * A single content block on a Voicescape page.
 * @typedef {object} PageBlock
 * @property {string} type - Block type (e.g. "hero", "text", "image", "links").
 * @property {string} [title] - Optional block title.
 * @property {*} [data] - Block payload.
 */

/**
 * The canonical shape of a Voicescape page document.
 * @typedef {object} VoicescapePage
 * @property {string} version - Schema version (e.g. "1.0.0").
 * @property {string} username - Page owner's username.
 * @property {PageBlock[]} blocks - Ordered content blocks.
 * @property {string} [updatedAt] - ISO-8601 last-modified timestamp.
 * @property {*} [theme] - Optional theme/profile styling data.
 */

/**
 * Result of a successful publish.
 * @typedef {object} PublishResult
 * @property {string} cid - The IPFS content identifier of the pinned JSON.
 * @property {string} provider - Which provider pinned it ("pinata").
 * @property {number} [pinSize] - Byte size reported by the provider, when available.
 */

/** Default IPFS gateway host (no protocol) used when none is configured. */
const DEFAULT_GATEWAY = "ipfs.io";

/** Env var names used by this module. */
const ENV = {
  PINATA_JWT: "PINATA_JWT",
  IPFS_GATEWAY: "IPFS_GATEWAY",
  PIN_MAX_PAGE_JSON_BYTES: "PIN_MAX_PAGE_JSON_BYTES",
};

/** Default max pinned page JSON: 1 MB. Pages are small; this is a generous ceiling. */
export const DEFAULT_MAX_PAGE_JSON_BYTES = 1_048_576;

/**
 * Max page-JSON byte size the server will pin, from PIN_MAX_PAGE_JSON_BYTES
 * (default 1,048,576). Pinata's free tier is finite — without a cap an
 * authenticated wallet could burn the whole allowance one request at a time.
 */
export function maxPageJsonBytes() {
  const raw = process.env[ENV.PIN_MAX_PAGE_JSON_BYTES];
  if (raw && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return DEFAULT_MAX_PAGE_JSON_BYTES;
}

/**
 * Validate that an object looks like a Voicescape page document.
 * Throws a descriptive Error on the first problem found.
 *
 * @param {*} pageObj - The candidate page object.
 * @returns {VoicescapePage} The same object, typed as a VoicescapePage.
 * @throws {Error} If the object is not a valid Voicescape page.
 */
export function validatePageJson(pageObj) {
  if (pageObj === null || typeof pageObj !== "object" || Array.isArray(pageObj)) {
    throw new Error(
      "Invalid Voicescape page: expected a plain object, got " +
        (Array.isArray(pageObj) ? "array" : typeof pageObj),
    );
  }
  if (pageObj.version !== 1 && pageObj.version !== "1" && pageObj.version !== "1.0.0") {
    throw new Error(
      'Invalid Voicescape page: "version" must be 1 (number) or "1"/"1.0.0" (string).',
    );
  }
  if (typeof pageObj.username !== "string" || pageObj.username.trim() === "") {
    throw new Error(
      'Invalid Voicescape page: missing or empty "username" (string).',
    );
  }
  if (!Array.isArray(pageObj.blocks)) {
    throw new Error(
      'Invalid Voicescape page: "blocks" must be an array of content blocks.',
    );
  }
  return /** @type {VoicescapePage} */ (pageObj);
}

/**
 * Very light CID sanity check: non-empty string without path separators or
 * whitespace. This only guards against obvious garbage being interpolated
 * into the gateway URL — full CID validation happens server-side.
 *
 * @param {string} cid
 * @returns {boolean}
 */
function looksLikeCid(cid) {
  return (
    typeof cid === "string" &&
    cid.length > 0 &&
    /^[A-Za-z0-9]+$/.test(cid)
  );
}

/**
 * Pin the page JSON to IPFS via Pinata's pinJSONToIPFS REST endpoint.
 *
 * Verified endpoint shape (Pinata docs):
 *   POST https://api.pinata.cloud/pinning/pinJSONToIPFS
 *   Headers: Authorization: Bearer <JWT>, Content-Type: application/json
 *   Body: { pinataContent, pinataMetadata: { name }, pinataOptions }
 *   Success: 200 + { IpfsHash, PinSize, Timestamp }
 *
 * @param {VoicescapePage} page - Validated page object.
 * @param {string} jwt - Pinata JWT (from PINATA_JWT).
 * @returns {Promise<PublishResult>}
 * @throws {Error} On non-2xx responses or network failure.
 */
async function pinViaPinata(page, jwt) {
  const body = {
    pinataContent: page,
    pinataMetadata: {
      name: `voicescape-${page.username}`,
    },
  };

  let res;
  try {
    res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Pinata upload failed (network error): ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Pinata upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }

  /** @type {{ IpfsHash?: string, PinSize?: number }} */
  const data = await res.json().catch(() => ({}));
  if (!data.IpfsHash) {
    throw new Error(
      "Pinata upload succeeded but the response had no IpfsHash.",
    );
  }
  return { cid: data.IpfsHash, provider: "pinata", pinSize: data.PinSize };
}

/**
 * Publish a Voicescape page's JSON to IPFS via Pinata.
 *
 * The object is validated before any network call. Requires PINATA_JWT.
 *
 * @param {*} pageObj - The page document to publish.
 * @returns {Promise<PublishResult>} `{ cid, provider }`.
 * @throws {Error} If validation fails, PINATA_JWT is unset, or Pinata errors.
 */
export async function publishPageJson(pageObj) {
  const page = validatePageJson(pageObj);

  // Size cap: measure the actual JSON before any network call. Keeps one
  // wallet from burning the Pinata free allowance with giant pins.
  const json = JSON.stringify(page);
  const max = maxPageJsonBytes();
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > max) {
    throw new Error(
      `page JSON too large (${bytes} bytes; max ${max} bytes) — shrink the page before publishing`,
    );
  }

  const pinataJwt = process.env[ENV.PINATA_JWT];
  if (!pinataJwt) {
    // User-facing copy is set by the /api/pin route — this marker is
    // matched there to return human guidance instead of config jargon.
    // Server logs get the full detail via console.error in the route.
    throw new Error("PINATA_UNAVAILABLE");
  }

  return pinViaPinata(page, pinataJwt);
}

/**
 * Pin a raw file (e.g. the page owner's own audio upload) to IPFS via
 * Pinata's pinFileToIPFS REST endpoint.
 *
 * Verified endpoint shape (Pinata docs):
 *   POST https://api.pinata.cloud/pinning/pinFileToIPFS
 *   Headers: Authorization: Bearer <JWT> (Content-Type set by FormData)
 *   Body: multipart/form-data with a "file" field (+ optional pinataMetadata)
 *   Success: 200 + { IpfsHash, PinSize, Timestamp }
 *
 * @param {Buffer|Uint8Array} data - File bytes.
 * @param {string} filename - Original filename (sent as the multipart filename).
 * @param {string} contentType - MIME type, e.g. "audio/mpeg".
 * @param {string} jwt - Pinata JWT (from PINATA_JWT).
 * @returns {Promise<PublishResult>}
 * @throws {Error} On non-2xx responses or network failure.
 */
async function pinFileViaPinata(data, filename, contentType, jwt) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([data], { type: contentType || "application/octet-stream" }),
    filename || "upload.bin",
  );
  form.append(
    "pinataMetadata",
    JSON.stringify({ name: `voicescape-audio-${filename || "upload"}` }),
  );

  let res;
  try {
    res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
      body: form,
    });
  } catch (err) {
    throw new Error(`Pinata file upload failed (network error): ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Pinata file upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
    );
  }

  /** @type {{ IpfsHash?: string, PinSize?: number }} */
  const out = await res.json().catch(() => ({}));
  if (!out.IpfsHash) {
    throw new Error("Pinata file upload succeeded but the response had no IpfsHash.");
  }
  return { cid: out.IpfsHash, provider: "pinata", pinSize: out.PinSize };
}

/** Max audio upload: 25 MB. The browser checks too; the server is the authority. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Pin a user-uploaded audio file to IPFS via Pinata.
 * Requires PINATA_JWT. Re-validates MIME + size server-side.
 *
 * @param {Buffer|Uint8Array} data - File bytes.
 * @param {string} filename - Original filename.
 * @param {string} contentType - MIME type; must start with "audio/".
 * @returns {Promise<PublishResult>} `{ cid, provider }`.
 * @throws {Error} If validation fails, PINATA_JWT is unset, or Pinata errors.
 */
export async function publishAudioFile(data, filename, contentType) {
  if (!contentType || !contentType.startsWith("audio/")) {
    throw new Error(
      `Refusing to pin non-audio upload (content-type "${contentType || "missing"}").`,
    );
  }
  if (!data || data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio upload too large (max ${(MAX_AUDIO_BYTES / 1024 / 1024).toFixed(0)} MB).`,
    );
  }
  const pinataJwt = process.env[ENV.PINATA_JWT];
  if (!pinataJwt) {
    throw new Error("PINATA_UNAVAILABLE");
  }
  return pinFileViaPinata(data, filename, contentType, pinataJwt);
}

/**
 * Fetch a published page JSON from an IPFS gateway.
 *
 * @param {string} cid - The IPFS CID of the page document.
 * @param {string} [gateway] - Gateway host (e.g. "ipfs.io"). Defaults to
 *   the IPFS_GATEWAY env var, then "ipfs.io".
 * @returns {Promise<VoicescapePage>} The parsed page document.
 * @throws {Error} On malformed CID, network failure, non-2xx responses, or
 *   invalid JSON.
 */
export async function fetchPageJson(cid, gateway) {
  if (!looksLikeCid(cid)) {
    throw new Error(
      "Invalid CID: expected a non-empty base58/base32 string without slashes or spaces.",
    );
  }
  const host = gateway || process.env[ENV.IPFS_GATEWAY] || DEFAULT_GATEWAY;
  const url = `https://${host}/ipfs/${cid}`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new Error(`Failed to fetch CID ${cid} from ${host}: ${err.message}`);
  }

  if (!res.ok) {
    throw new Error(
      `Failed to fetch CID ${cid} from ${host}: HTTP ${res.status} ${res.statusText}`,
    );
  }

  const text = await res.text();
  try {
    return /** @type {VoicescapePage} */ (JSON.parse(text));
  } catch {
    throw new Error(
      `Failed to parse JSON for CID ${cid} from ${host}: response was not valid JSON.`,
    );
  }
}
