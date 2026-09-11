# @voicescape/storage (scaffold)

**Not yet extracted.** Planned home for content storage:

- IPFS pinning via Pinata (free tier) — `pinPageJson` and gateway reads.
- Optional HCS anchoring: store each page's CID + SHA-256 in an HCS topic
  message at registration (~$0.0008/message) for verifiable, timestamped,
  permanent provenance.

## Why not Hedera File Service

Researched 2026-09-11: HFS costs ~$0.10/KB written (~$1.06 per 10KB page),
files expire after ~91 days with no auto-renew, and browsers cannot read
file contents (no mirror-node file endpoint). IPFS + HCS anchoring is the
correct Hedera-first answer.

## Source material (monolith)

- `frontend/lib/ipfs.ts` — Pinata wrapper (89 lines)

## Status

Scaffold only. Extract after `apps/web` migration begins.
