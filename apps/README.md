# apps/

Future application shells in the Voicescape monorepo.

```
apps/
├── web/          # Next.js PWA frontend (the main app)
├── admin/        # Admin dashboard (moderation, analytics, treasury)
└── marketplace/  # Standalone marketplace app (optional split)
```

## Migration plan

The production monolith lives at `../frontend/` and is deployed to Vercel
from that directory. **Do not move it until the package migration is
proven:**

1. ✅ Phase 1 (done): extract `@voicescape/wallet`, `@voicescape/contracts`,
   `@voicescape/ui` as standalone packages alongside the monolith.
2. Phase 2: point `frontend/` imports at the workspace packages
   (`lib/wallet.tsx` → `@voicescape/wallet`, etc.), verify 1:1 behavior,
   deploy.
3. Phase 3: move `frontend/` → `apps/web/`, update Vercel root directory,
   verify deploy.
4. Phase 4: split `apps/admin` (moderation + analytics UI on existing APIs).

The deployed app must keep working at every step.
