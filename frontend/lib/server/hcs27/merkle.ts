/**
 * HCS-27 Merkle tree functions — vendored from @hashgraphonline/standards-sdk.
 *
 * Source: https://github.com/hashgraph-online/standards-sdk/blob/main/src/hcs-27/merkle.ts
 * License: (check upstream — Hedera open-source)
 *
 * Vendored rather than installed because:
 * 1. HCS-27 is not yet in the npm package (GitHub main only)
 * 2. These functions are pure (node:crypto only) — zero Hedera SDK dependencies
 * 3. Avoids bundling @hashgraph/sdk alongside our @hiero-ledger/sdk
 *
 * RFC 9162 style: leaf = SHA256(0x00 || canonical_entry),
 * node = SHA256(0x01 || left || right).
 * Canonical JSON: keys sorted by code point, no whitespace.
 */
import { createHash } from "crypto";

function normalizeJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return Array.from(value, (item) =>
      item === undefined ? null : normalizeJsonValue(item),
    );
  }

  if (typeof value === "object") {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") {
      return normalizeJsonValue(toJSON.call(value));
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = normalizeJsonValue(item);
      }
    }
    return result;
  }

  throw new Error(`Unsupported JSON value type: ${typeof value}`);
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) {
    return "0";
  }
  return value.toString();
}

function writeCanonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return formatNumber(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => writeCanonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${writeCanonicalJson(item)}`,
      )
      .join(",")}}`;
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`);
}

function largestPowerOfTwoLessThan(value: number): number {
  if (value <= 1) {
    return 0;
  }
  let result = 1;
  while (result << 1 < value) {
    result <<= 1;
  }
  return result;
}

export function canonicalizeHCS27Json(value: unknown): Buffer {
  const normalized = normalizeJsonValue(value);
  return Buffer.from(writeCanonicalJson(normalized), "utf8");
}

export function emptyHCS27Root(): Buffer {
  return createHash("sha256").update(Buffer.alloc(0)).digest();
}

export function hashHCS27Leaf(canonicalEntry: Buffer | Uint8Array): Buffer {
  return createHash("sha256")
    .update(Buffer.from([0x00]))
    .update(Buffer.from(canonicalEntry))
    .digest();
}

export function hashHCS27Node(
  left: Buffer | Uint8Array,
  right: Buffer | Uint8Array,
): Buffer {
  return createHash("sha256")
    .update(Buffer.from([0x01]))
    .update(Buffer.from(left))
    .update(Buffer.from(right))
    .digest();
}

export function merkleRootFromCanonicalEntries(
  entries: ReadonlyArray<Buffer | Uint8Array>,
): Buffer {
  if (entries.length === 0) {
    return emptyHCS27Root();
  }
  if (entries.length === 1) {
    return hashHCS27Leaf(entries[0]);
  }

  const split = largestPowerOfTwoLessThan(entries.length);
  const left = merkleRootFromCanonicalEntries(entries.slice(0, split));
  const right = merkleRootFromCanonicalEntries(entries.slice(split));
  return hashHCS27Node(left, right);
}

export function merkleRootFromEntries(
  entries: ReadonlyArray<unknown>,
): Buffer {
  const canonicalEntries = entries.map((entry) =>
    canonicalizeHCS27Json(entry),
  );
  return merkleRootFromCanonicalEntries(canonicalEntries);
}

export function leafHashHexFromEntry(entry: unknown): string {
  return hashHCS27Leaf(canonicalizeHCS27Json(entry)).toString("hex");
}

/** Base64url encode (no padding) for HCS-27 root hashes. */
export function toBase64Url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
