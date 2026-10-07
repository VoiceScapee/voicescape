# HCS-27 Leaf Rule — Voicescape Transparency Log

**Attestation topic:** `0.0.10908351` (Hedera mainnet, public — no submit key)
**Verify:** https://hashscan.io/mainnet/topic/0.0.10908351
**Anchor topic:** `0.0.10908357` (Hedera mainnet, admin-anchored checkpoints)
**Verify:** https://hashscan.io/mainnet/topic/0.0.10908357
**Log ID:** `agent-reviews`

> **IMPORTANT:** HCS-27 is a COMMUNITY DRAFT
> ([hiero-ledger/hiero-consensus-specifications](https://github.com/hiero-ledger/hiero-consensus-specifications),
> by Connor Snitker), NOT an official Hedera standard.
> We follow the draft spec for interoperability. Never claim official status.

## Caller-pays model

Per our cost invariant (users pay their own gas), **the platform never
signs or pays for review-related chain writes**. When `review_agent_tipping`
returns an unsigned attestation transaction:

- The **caller** signs it with their own key and pays the HCS message fee
  (~$0.0001 — fractions of a cent).
- The single attestation message embeds **both** the public attestation
  **and** the HCS-27 transparency leaf for the review.
- The caller's one signature covers both. One transaction, one tiny fee.

The transparency log **is** the public attestation topic's message history
— anyone can rebuild the Merkle tree from it. No separate platform-paid
write is needed for the transparency guarantee.

The anchor topic (`0.0.10908357`) carries periodic Merkle-root checkpoints
for validator convenience. These are **admin-triggered only** — never
per-review, never from user-facing code paths.

## How to verify a review was included

Each attestation message on `0.0.10908351` contains its own HCS-27 leaf.
To verify:

### 1. The leaf rule

```
LeafHash = SHA256(0x00 || canonical_bytes)
```

Where:
- `canonical_bytes` = the review entry serialized as **JCS canonical JSON**
  (RFC 8785: keys sorted by Unicode code point, no whitespace, UTF-8, no BOM)
- `0x00` = a single zero byte prepended (RFC 9162 leaf domain separator)

### 2. What gets hashed (the entry)

Each attestation message has this shape:

```json
{
  "type": "voicescape.tipping_review.v1",
  "reviewer": "voicescape-reviewer-v1",
  "subject": "<original subject string>",
  "verdict": "clean | flagged | insufficient_data",
  "report_hash": "<sha256 of the full review report>",
  "attested_at": "<ISO 8601 timestamp>",
  "hcs27": {
    "leaf_hash": "<hex of SHA256(0x00 || JCS(entry))>",
    "leaf_alg": "sha256(0x00 || jcs(entry))",
    "merkle": "rfc9162",
    "entry": {
      "report_hash": "<sha256 of the full review report>",
      "subject": "<original subject string>",
      "subject_account": "<resolved 0.0.x account>",
      "verdict": "clean | flagged | insufficient_data",
      "confidence": "low | medium | high",
      "summary": "<human-readable verdict summary>",
      "tips_analyzed": "<number>",
      "checked_at": "<ISO 8601 timestamp>",
      "reviewer": "voicescape-reviewer-v1"
    }
  }
}
```

To verify: recompute `SHA256(0x00 || JCS(entry))` and check it matches
`hcs27.leaf_hash`. The full review (with per-tip evidence) is available via
the `review_agent_tipping` MCP tool — recompute the report hash to verify
the entry matches the review.

### 3. The tree

- **Leaf:** `SHA256(0x00 || JCS(entry))` (see above)
- **Internal node:** `SHA256(0x01 || left || right)` where left/right are
  raw 32-byte hashes (RFC 9162 node domain separator)
- **Split:** left-balanced — split at the largest power of two strictly
  less than N (number of leaves)
- **Empty tree root:** `SHA256("")` =
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

Rebuild the tree from all `hcs27.entry` values in the attestation topic's
message history (in consensus order) to get the current root.

### 4. Anchor checkpoints (admin-triggered)

Periodic checkpoints may be published to `0.0.10908357` with this shape:

```json
{
  "p": "hcs-27",
  "op": "register",
  "metadata": {
    "type": "ans-checkpoint-v1",
    "stream": { "registry": "voicescape", "log_id": "agent-reviews" },
    "log": { "alg": "sha-256", "leaf": "sha256(jcs(event))", "merkle": "rfc9162" },
    "root": { "treeSize": "<n as base-10 string>", "rootHashB64u": "<base64url, no padding>" },
    "prev": { "treeSize": "<n>", "rootHashB64u": "<hash>" } | null,
    "sig": null
  }
}
```

- `metadata.type` is `"ans-checkpoint-v1"` per the HCS-27 draft spec
  (normative requirement — validators reject anything else).
- `prev` chains to the previous checkpoint's root (consistency proof).
  `null` on the first checkpoint.
- These are convenience anchors only. The attestation topic is the
  source of truth.

### 5. Worked verification

```python
import hashlib, json

def jcs(obj):
    # RFC 8785: sort keys, no whitespace, utf-8
    return json.dumps(obj, sort_keys=True, separators=(',',':'),
                      ensure_ascii=False).encode('utf-8')

def leaf_hash(entry):
    return hashlib.sha256(b'\x00' + jcs(entry)).digest()

def node_hash(left, right):
    return hashlib.sha256(b'\x01' + left + right).digest()

# 1. Fetch attestation messages from the mirror node:
#    GET https://mainnet.mirrornode.hedera.com/api/v1/topics/0.0.10908351/messages?order=asc
# 2. Base64-decode each `message` field, parse JSON
# 3. For each: recompute leaf_hash from hcs27.entry, check against hcs27.leaf_hash
# 4. Recompute the Merkle root using the tree rules above
# 5. Optionally compare against the latest anchor checkpoint on 0.0.10908357
```

## What the caller pays

| Item | Cost (approx) |
|---|---|
| HCS attestation message (with embedded leaf) | ~$0.0001 |
| **Total per review** | **~$0.0001** |

One transaction, one signature, one tiny fee — paid by the caller (the
reviewer), never by the platform.

## Reference

- HCS-27 draft spec: hiero-ledger/hiero-consensus-specifications
- Hashgraph Online standards SDK (community): hashgraph-online/standards-sdk
- RFC 9162 (Merkle tree hashing), RFC 8785 (JCS canonical JSON)
