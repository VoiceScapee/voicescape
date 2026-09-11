# @voicescape/ai (scaffold)

**Not yet extracted.** Planned home for AI integrations:

- BYOK / x402 model — users supply their own key or pay per request;
  the platform pays $0 (`frontend/lib/byok.ts`).
- OpenAI-compatible provider support (`LLM_BASE_URL`), with OpenRouter
  `:free` models as the keyless $0 default.
- Agent transaction builder (`POST /api/agents/execute`) — builds unsigned
  Hedera tx bytes for wallet approval; server never holds keys.
- Voice-to-page: Web Speech API dictation in the builder (browser-native,
  $0, no service).

## Constraints (Brandon's rules)

- Platform AI cost is always $0 — users bring their own key, use free
  models, or pay per request via x402.
- Vendor/model agnostic — never siloed to one provider.
- AI-positive: fees make spam uneconomical; the product welcomes agents.

## Status

Scaffold only. Extract after `apps/web` migration begins.
