# Social Activity Producers

Who should call `POST /api/social/activity/log` and how.

## The rule (Brandon's standing rule)

**Only actually-sent posts get logged.** Call the endpoint AFTER the post
is confirmed live:

- **Discord bot** — after the Discord API returns 200 for the message
  (the bot's "You asked, shipped" follow-ups, ship-log posts, etc.).
- **X automation** — after the post is confirmed on the X timeline.

Never log scheduled, queued, drafted, or failed posts. Never backfill.
The endpoint records; it never posts anything itself. Logging is
best-effort: if the call fails, the post already went out — log the
failure locally and move on. Logging must never break posting.

## The call

```
curl -X POST https://voicescape.vercel.app/api/social/activity/log \
  -H "Authorization: Bearer $SOCIAL_LOG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platform":"discord","summary":"posted the daily ship log"}'
```

- `platform`: `"x"` or `"discord"` — required.
- `summary`: short internal note, max 300 chars — required. This stays
  **server-side only**: the public `GET /api/social/activity` feed is
  content-free (platform + timestamp) and never serves summaries. No
  X/Discord post text, captions, or previews ever leave the server.
- `ts`: optional ISO timestamp of when the post was confirmed live.
  Omit it and the server stamps arrival time. When supplied it must be
  a valid ISO date, not more than 5 minutes in the future, and not older
  than 7 days (the store's retention window).

Responses: `201 {ok:true}` recorded · `400` invalid body ·
`401` missing/bad token (also 401 when the server env var is unset) ·
`429` rate limited.

## Auth setup (server side)

Set `SOCIAL_LOG_TOKEN` on the deployment (Vercel env vars, production).
Pick a long random value. The VM-side producers read it from the same
place the other dapp tokens live (Secure Vault) — never hardcode it,
never commit it.

## The two sinks

This endpoint writes sink 1: the shared KV store (`social:activity:v1`,
capped at 50 events, 7-day TTL, deduped on platform+timestamp).

Sink 2 is the public gist `social.json` (platform + timestamp ONLY, never
post text), written by the VM-side logger
(`~/workspace/ops/social-log/log_social.py`) through the `gh` CLI — the
sink the bots can always reach. The public feed merges both sinks and
dedupes on platform+timestamp, so an event logged to both appears once.
