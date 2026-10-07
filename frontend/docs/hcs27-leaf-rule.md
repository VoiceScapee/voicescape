# HCS-27 Leaf Rule — Voicescape Transparency Log

**Topic:** `0.0.10908357` (Hedera mainnet)
**Verify:** https://hashscan.io/mainnet/topic/0.0.10908357
**Log ID:** `agent-reviews`

> **IMPORTANT:** HCS-27 is a COMMUNITY DRAFT
> ([hiero-ledger/hiero-consensus-specifications](https://github.com/hiero-ledger/hiero-consensus-specifications),
> by Connor Snitker), NOT an official Hedera standard.
> We follow the draft spec for interoperability. Never claim official status.

## How to verify a review was included

Each checkpoint published to the topic contains a Merkle root over a batch
of review entries. To verify your review is in a checkpoint:

### 1. The leaf rule

```
LeafHash = SHA256(0x00 || canonical_bytes)
```

Where:
- `canonical_bytes` = the review entry serialized as **JCS canonical JSON**
  (RFC 8785: keys sorted by Unicode code point, no whitespace, UTF-8, no BOM)
- `0x00` = a single zero byte prepended (RFC 9162 leaf domain separator)

### 2. What gets hashed (the entry)

Each review entry is this JSON object (before canonicalization):

```json
{
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
```

The full review (with per-tip evidence) is available via the
`review_agent_tipping` MCP tool. The `report_hash` in the entry binds the
leaf to the full report — recompute the report hash to verify the entry
matches the review.

### 3. The tree

- **Leaf:** `SHA256(0x00 || JCS(entry))` (see above)
- **Internal node:** `SHA256(0x01 || left || right)` where left/right are
  raw 32-byte hashes (RFC 9162 node domain separator)
- **Split:** left-balanced — split at the largest power of two strictly
  less than N (number of leaves)
- **Empty tree root:** `SHA256("")` =
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

### 4. The checkpoint message

Each topic message is JSON:

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
- `sig` is currently `null` — the HCS transaction itself provides payer
  identity (the ops wallet `0.0.10857765` holds the topic submit key).

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

# 1. Fetch the latest checkpoint from the mirror node:
#    GET https://mainnet.mirrornode.hedera.com/api/v1/topics/0.0.10908357/messages?limit=1&order=desc
# 2. Base64-decode the `message` field, parse JSON
# 3. Recompute the leaf for your review entry
# 4. Recompute the root using the tree rules above
# 5. Compare to metadata.root.rootHashB64u (base64url-decode first)
```

## Reference

- HCS-27 draft spec: hiero-ledger/hiero-consensus-specifications
- Hashgraph Online standards SDK (community): hashgraph-online/standards-sdk
- RFC 9162 (Merkle tree hashing), RFC 8785 (JCS canonical JSON)
