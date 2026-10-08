# Widget Beacon Spec — FROZEN

**Status:** FROZEN as of 2026-10-07
**Version:** 1.0
**Author:** Danny (Voicescape)
**Consumer:** autonomaavalix (ingest-side validation), any independent observer

This document describes the exact, stable shape of the widget delivery
beacon. It is frozen: field names, types, and semantics will not change
without a version bump and a notice to consumers. autonomaavalix is
building assert-on-ingest checks against this spec.

## Overview

When an agent calls the `render_blockpage` MCP tool, the server mints a
widget-instance id (`wid`) and returns it alongside the invocation id
(`iid`). The MCP Apps widget appends both to open-link URLs. When the
destination page loads with `?wid=` + `?iid=`, it fires a beacon to
`/api/widget-visit`. The beacon proves the round trip completed:
an issued widget that was never visited means the host dropped the
open-link.

The invocation id (`iid`) is the caller's JSON-RPC request `id`,
threaded through so independent observers can join beacon rows against
their own request log without inferring batching.

## Beacon shape

```
POST /api/widget-visit
Content-Type: application/json

{
  "wid": "K7M2P9X4",
  "iid": "abc-123"
}
```

### Fields

| Field | Type   | Required | Constraints                          | Semantics                                    |
|-------|--------|----------|--------------------------------------|----------------------------------------------|
| `wid` | string | YES      | 8 chars, `[A-Z2-9]` (no I, O, L, 0, 1) | Widget-instance id minted by `render_blockpage`. 1:1 with the tool call. |
| `iid` | string | YES      | 1–128 chars, opaque                  | The caller's JSON-RPC request `id` (stringified). Present on success AND failure. |

### wid semantics

- Minted once per `render_blockpage` call via `mintWidgetId()`.
- Returned as `_wid` in the tool result.
- 1:1 with the `render_blockpage` invocation — never reused, never shared.
- Logged server-side at issuance (`logWidgetIssued`).

### iid semantics

- The caller's JSON-RPC request `id`, captured by `/api/mcp` and threaded
  through the request context.
- Returned as `_iid` in the `render_blockpage` tool result on **both
  success and failure** (stringified if the request id was a number).
- If the JSON-RPC request had no `id` (notification), `_iid` is omitted —
  this is the only case where it is absent from the tool result.
- Opaque: no PII, no structure to parse. Join it against your own
  request log.

## Failure paths

### Failed renders emit iid

If `render_blockpage` fails (unknown user, validation error, internal
error), the tool result still carries `_iid`:

```json
{
  "error": "Blockpage not found.",
  "_iid": "abc-123"
}
```

No `_wid` is minted on failure — no widget was issued, so there is
nothing to track delivery for.

### MCP timeouts

JSON-RPC error responses always echo the request `id` per the spec.
Tool-level timeouts surface as `isError: true` results carrying `_iid`.

## /api/widget-visit validation

The endpoint validates strictly. Missing or empty `iid` is a **hard
fail** (HTTP 400), not a quiet null.

### Success

```
→ 200 { "ok": true }
```

### Errors

| HTTP | `error` code   | Meaning                                          |
|------|----------------|--------------------------------------------------|
| 400  | `INVALID_WID`  | `wid` is missing or not an 8-char widget id      |
| 400  | `UNKNOWN_WID`  | `wid` was not issued by this server              |
| 400  | `MISSING_IID`  | `iid` is missing, empty, or longer than 128 chars|

Error body shape:

```json
{
  "ok": false,
  "error": "MISSING_IID",
  "message": "iid (invocation id) is required — pass the _iid from render_blockpage"
}
```

## Widget behavior

The MCP Apps widget (`lib/server/mcp-widgets.ts`):

1. Extracts `_wid` and `_iid` from the `render_blockpage` tool result
   (including error results — `_iid` is captured before the error card
   renders).
2. Appends `?wid=<wid>&iid=<iid>` to every open-link URL it asks the
   host to open.
3. Records each open-link in its local call log
   (`window.__VOICESCAPE_CALL_LOG__`) with the final URL.

The destination page (`/[username]`) reads `wid`/`iid` from the URL
query params and fires the beacon. If `iid` is absent from the URL
(old widget, broken chain), the page **skips the beacon** and logs a
console warning instead of firing a request that would 400.

## Example flows

### Happy path

```
Agent → POST /api/mcp  {"jsonrpc":"2.0","id":"req-1","method":"tools/call",
                         "params":{"name":"render_blockpage",...}}
     ← {"result":{"content":[{"text":"{\"username\":\"...\",\"_wid\":\"K7M2P9X4\",\"_iid\":\"req-1\"}"}]}}

Widget → open-link https://voicescape.vercel.app/someuser?wid=K7M2P9X4&iid=req-1

Page   → POST /api/widget-visit {"wid":"K7M2P9X4","iid":"req-1"}
     ← 200 {"ok":true}
```

### Failed render

```
Agent → POST /api/mcp  {"jsonrpc":"2.0","id":"req-2","method":"tools/call",
                         "params":{"name":"render_blockpage",
                                   "arguments":{"username":"nosuchuser"}}}
     ← {"result":{"isError":true,"content":[{"text":"{\"error\":\"...\",\"_iid\":\"req-2\"}"}]}}
(no widget, no beacon — the agent correlates the failure via _iid)
```

### Missing iid beacon

```
     → POST /api/widget-visit {"wid":"K7M2P9X4"}
     ← 400 {"ok":false,"error":"MISSING_IID","message":"..."}
```

## Changelog

- **1.0 (2026-10-07):** Frozen. `_iid` on failure paths, hard 400 on
  missing/empty iid, widget captures `_iid` from error results.
- Pre-1.0 (2026-10-06): `_iid` only on success; missing iid silently
  logged as undefined; always 200.
