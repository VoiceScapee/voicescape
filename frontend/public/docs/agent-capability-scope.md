# Keyless Agent Operation — Capability Token Scope

A way for an AI agent to help maintain a Voicescape blockpage without ever
touching a private key.

How it works in one paragraph: the agent holds a bearer capability token —
not a key, not signing material, just a token that says "this agent may submit
proposals." The agent submits content proposals. Each proposal lands in the
human's chat as a one-tap approval card. The human approves, and the human's
own wallet signs the on-chain update. The agent never signs anything, never
holds anything signable, and nothing changes on-chain until the human says yes.

## What the token allows

1. **Propose page content updates.** The agent submits new content. The server
   stages it and the proposal appears in the human's chat as an approval card
   with the agent's plain-words summary of the change to review.
2. **Read page, directory, and registry data.** Publicly visible on-chain
   data about pages — same as anyone browsing the site can see.
3. **Pin media to IPFS through Voicescape's server.** Images and files for
   proposed content updates go through our pinned storage.

That is the complete list. The token does not grant anything else.

## What the token explicitly cannot do

There is no token scope for these. No code path reachable from a proposal can
perform them:

- **Fund movement of any kind** — no transfers, no tips, no withdrawals.
- **Ownership changes** — no page registration, no ownership transfer.
- **Key changes** — no account updates of any kind.
- **Token operations** — no HTS create, mint, transfer, burn, or anything
  like them.

The token cannot sign anything by itself. It only authorizes the agent to
*submit proposals*. The human's wallet signature is the sole authorizer of
every chain write.

## Rules of the proposal flow

- **Consent is recorded once.** Issuing a token requires the human's wallet
  signature, so there is a signed consent record before the agent can propose
  anything.
- **How the token travels.** Pass it as the `capability_token` argument to
  `propose_page_update`, **or** send it as the HTTP
  `Authorization: Bearer <token>` header on the MCP endpoint and omit the
  argument entirely. The header path is for agents whose runtime injects
  vault-held credentials automatically — the agent never sees the value,
  and it never appears in chat, logs, or tool-call records. When both are
  present, the explicit argument wins. Either way, scopes are enforced
  server-side from the token itself.
- **Proposals expire.** A proposal untouched for 24 hours expires automatically.
- **Max 3 pending proposals per owner.** A fourth proposal is rejected until
  the human reviews or the old ones expire.

## Revocation

The human revokes the token in one action, and it takes effect **instantly**.
The next proposal attempt after revocation fails closed — nothing gets
through, nothing is queued. There is no grace window and no propagation
delay.

## Auditability

Every approved update is a normal `updatePage` transaction on Hedera mainnet,
signed by the human's wallet. Like any other transaction, it is attributable
and verifiable on the public mirror node and on HashScan.

## Cost

Proposing is free. When the human approves, their approval signature costs a
small amount of Hedera network gas — a few cents of HBAR, paid from the
human's wallet to the Hedera network, not to Voicescape.

---

*Last updated: 2026-10-06*
