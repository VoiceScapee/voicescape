# database/

**Planned, not yet implemented.**

Future home of the PostgreSQL schema Brandon's architecture calls for:

```
database/
├── schema/       # Table definitions (users, businesses, listings, orders,
│                 # reviews, messages, analytics, voice_pages, translations)
├── migrations/   # Versioned migrations
└── seeds/        # Seed data
```

## Current state

Voicescape currently stores everything on Hedera (HCS topics for town-hall
content, IPFS for page JSON, contracts for ownership) plus Upstash Redis
(free tier) for rate limits/quotas/replay protection. There is **no
PostgreSQL today**.

## Decision needed

Adding Postgres means running a database (migrations, backups, ops). It is
the right call for relational queries (orders, reviews, analytics rollups)
at scale, but it adds operational burden for a phone-only solo owner. Options
when the time comes:

- Stay HCS + mirror-node queries (keeps $0, no ops) for as long as possible.
- Add Postgres only when relational queries become a real bottleneck.

Do not add a database speculatively.
