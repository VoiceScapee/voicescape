# services/

Future backend services in the Voicescape monorepo.

```
services/
├── mirror-node/    # Hedera mirror-node REST client (dashboards, indexing)
├── ipfs/           # IPFS pinning service wrapper (Pinata today)
├── indexing/       # HCS topic indexer → queryable state
├── notifications/  # Push/in-app notifications
└── translations/   # i18n service (next-intl string management)
```

## Current state

All of these are either in-process Next.js API routes in `../frontend/` or
not yet built. They are documented here so the architecture has a home for
them when they outgrow API routes.

## Principle

Hedera-first, open source, $0. A service earns its place here when it needs
independent scaling or a non-Next.js runtime — not before.
