# @voicescape/ipfs

IPFS helper module for Project Voicescape. Page content (the JSON behind a
MySpace-style block page) is published to IPFS; the smart contract only stores
a `username → CID` registry.

**Live code:** [`frontend/lib/server/publish.js`](../frontend/lib/server/publish.js)
— imported by the Next.js [`/api/pin`](../frontend/app/api/pin/route.ts) route.

Zero runtime dependencies, plain ESM JavaScript with JSDoc types. Requires
Node 18+ (global `fetch`). **Server-side only** — the Pinata JWT must never
reach the browser, so the frontend pins by POSTing page JSON to `/api/pin`
(see [`frontend/lib/ipfs.ts`](../frontend/lib/ipfs.ts)); reads go straight
from a public gateway.

## Pinning strategy: Pinata-only

We ship **one** pinning provider: Pinata.

- The web3.storage legacy token API was **sunset**; its successor Storacha
  uses UCAN delegation + CAR uploads — a much bigger integration for a
  fallback we'd never verified. Shipping an unverified fallback would be
  worse than none, so it was removed (Sept 2026).
- Adding a second provider later is a contained change: `publishPageJson`
  already returns `{ cid, provider }`.

## Usage

```js
import { publishPageJson, fetchPageJson } from "../../frontend/lib/server/publish.js";

const page = {
  version: 1,
  username: "brandon",
  blocks: [
    { type: "hero", title: "Welcome to my page" },
    { type: "links", data: ["https://example.com"] },
  ],
};

// Publish (requires PINATA_JWT)
const { cid, provider } = await publishPageJson(page);
console.log(cid, provider); // e.g. "Qm..." "pinata"
// Store `cid` on-chain in the Voicescape registry contract.

// Fetch back from a gateway
const loaded = await fetchPageJson(cid);
```

## Env vars

| Variable     | Purpose                                        |
| ------------ | ---------------------------------------------- |
| `PINATA_JWT` | Pinata API key (JWT). Required for publishing. |
| `IPFS_GATEWAY` | Gateway host for reads (default: `ipfs.io`). |

Secrets live in env vars only — never hard-code keys. `.env` is git-ignored.

## API

- `publishPageJson(pageObj)` → `Promise<{ cid, provider }>`
  Validates the object (`version` numeric `1` or legacy `"1"`/`"1.0.0"`,
  string `username`, array `blocks`), pins it with metadata name
  `voicescape-<username>`, and returns the CID (`provider: "pinata"`).
  Throws on invalid page JSON, missing `PINATA_JWT`, or Pinata errors.
- `fetchPageJson(cid, gateway?)` → `Promise<object>`
  GETs `https://<gateway>/ipfs/<cid>` and returns the parsed JSON.
  Throws a clear error on bad CID, network failure, non-2xx, or bad JSON.
- `validatePageJson(pageObj)` → the validated object (also called internally).

## Endpoint verification status (honest notes)

- **Pinata — VERIFIED.** `POST https://api.pinata.cloud/pinning/pinJSONToIPFS`
  with `Authorization: Bearer <JWT>`, body
  `{ pinataContent, pinataMetadata: { name }, pinataOptions }`, response
  `{ IpfsHash, PinSize, Timestamp }`. Matches Pinata's official docs/blog
  examples (checked 2026-09-09).
- **Gateway reads — standard.** `https://<gateway>/ipfs/<cid>` is the
  universal IPFS gateway convention; no provider-specific quirk assumed.

No real uploads were attempted during development (no real keys available).
