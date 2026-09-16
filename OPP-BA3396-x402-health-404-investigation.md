# OPP-BA3396 — Investigation: x402 `/health` 404 on `voicescape-x402-vibecode.onrender.com`

**Date:** 2026-09-15 ~21:05 EDT · **Investigator:** engine (Danny)
**Incident:** `x402-service-monitor` reported `GET https://voicescape-x402-vibecode.onrender.com/health` → HTTP 404 since **2026-09-13** (ongoing).

## Verdict (root cause)

**The Render service has NO running server instance — this is not an Express routing bug.**
Every request (`/`, `/health`, and a garbage path) returns an identical fast
(~1.6 s) `404 Not Found` with:

- header `x-render-routing: no-server`
- body `Not Found` (`text/plain`, 10 bytes)
- served by Cloudflare in front of Render

`x-render-routing: no-server` is Render's own router answering: *there is no
live server behind this hostname*. An Express 404 would have a body like
`Cannot GET /health` and would differ per route. The whole service is down,
so `/health` cannot answer — the 404 is Render's, not the app's.

## Timeline match (the smoking gun)

- **2026-09-13, 21:50 EDT** — commit `312a828` landed in `~/workspace/x402-vibecode`:
  *"Add danny's paid /copy-review endpoint (25c, settles to 0.0.10857765)"*.
  The Render blueprint (`render.yaml`) sets `autoDeploy: true`, so this commit
  auto-deployed.
- That commit added a **boot-time fail-fast** in `src/server.ts` (runs before
  `app.listen`):

  ```ts
  const copyReviewSellerAccountId = getCopyReviewSellerAccountId(); // throws when unset
  ```

  and in `src/payment.ts`:

  ```ts
  export function getCopyReviewSellerAccountId(): string {
    const id = process.env.COPY_REVIEW_SELLER_ACCOUNT_ID?.trim();
    if (!id) {
      throw new Error(
        "COPY_REVIEW_SELLER_ACCOUNT_ID is not set (the liaison agent account " +
          "receiving /copy-review payments).",
      );
    }
    return id;
  }
  ```

- `COPY_REVIEW_SELLER_ACCOUNT_ID` is **not in `render.yaml`** at all and is not a
  `sync: false` secret either — it can only be set manually in the Render
  dashboard Environment tab, which was never done. The new build threw during
  startup, Render's health checks (`healthCheckPath: /health`) failed, and the
  service ended with zero healthy instances → `no-server` 404s. Incident start
  (2026-09-13) lines up with this deploy to the hour.

## What is NOT the problem

- The `/health` route **exists** in code: `app.get("/health", …)` at
  `x402-vibecode/src/server.ts:294`, and `GET /` is also registered — both 404
  on the live service, which only a missing instance explains.
- Not a cold start: responses are fast (1.6–1.8 s) and Render routes a sleeping
  free-tier service; `no-server` means *zero* instances, not a sleeping one.
- The payment middleware only guards `POST /vibecode` and `POST /copy-review`;
  it cannot 404 `GET /health`.

## Recommended fix (needs Brandon's approval/tap — NOT applied)

Option A (fastest, his tap on Render dashboard): add
`COPY_REVIEW_SELLER_ACCOUNT_ID` = danny's liaison wallet account ID to the
service's Environment tab on Render, then redeploy/restart. Service boots,
`/health` returns 200.

Option B (code hardening, for a future engine change): make `/copy-review`
registration conditional on the env var instead of throwing at boot — `/health`
and `/` must never depend on an optional paid route. Fail-closed is preserved
(no route → no payment → no misrouted revenue), but a missing liaison key no
longer takes the whole service (and its health check) down. Suggested follow-up
task; do not implement without Brandon's go.

## Notes

- No chain transactions, no HBAR spend, no redeploys were performed or are
  needed for the fix. Secrets/Vault material untouched.
- The x402 service lives in `~/workspace/x402-vibecode` (separate repo from
  voicescape); the Render service name is `voicescape-x402-vibecode`.
- Monitor can stay as-is: once a healthy instance serves `/health`, the alert
  clears on its own.
