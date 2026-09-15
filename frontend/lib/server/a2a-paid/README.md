# Paid agent endpoint — testnet prototype (Phase 5)

**Status:** TESTNET ONLY. Incapable of touching mainnet by construction
(see `config.ts`: hardcoded testnet mirror, mainnet contract ids rejected,
`0.0.x`-only contract ids).

**Money rule (Brandon, 2026-09-15 — standing, refined same day):** keep it
simple — the buyer pays Blockpage Buddy itself, the agent they're
interacting with (`payToUsername`, mainnet: `forge`). The atomic 98/2
split applies per sale: 98% to the Buddy's wallet, 2% straight to
Brandon's treasury (`0.0.10424063`). Buddy builds the template; the user
claims it with their own unique wallet via the existing claim-a-blockpage
flow. After it profits, the Buddy's wallet forwards profits to Brandon's
wallet — and to no one else, ever (Danny ops runs the sweep on Brandon's
word). The endpoint is receive-only by construction: the server holds no
spend keys and no payout/withdraw code paths exist — money flows in from
buyers, nothing flows out.

## Endpoints

- `POST /api/a2a/orders` — body `{ product: "chat-50" | "blockpage-build", buyerAccount: "0.0.x" }`.
  Testnet mirror balance pre-check (≥ 5.5 HBAR). Success → **HTTP 402** + bill:
  `{ orderId, priceHbar: 5, payTo, payToUsername, function: "tipPage", memo: "vs-order:<orderId>", expiresAt }`.
- `POST /api/a2a/paid` — body `{ orderId, txId }`. Verifies via the TESTNET
  mirror node and returns `{ entitlement }` exactly once.

## Verification rules (`verify.ts`)

All must hold: tx `SUCCESS`, `entity_id` == Tips contract, memo contains the
exact order memo, contract result `0x1` + `to` == Tips contract + `tipPage`
selector (`0x8b0de5cb`) + amount ≥ 5 HBAR + the `tipPage` username argument
== the order's `recipientUsername` (Brandon's wallet), tx never claimed before.
Failures: 422 with a specific code (`tx_failed`, `wrong_contract`,
`memo_mismatch`, `wrong_function`, `wrong_recipient`, `underpaid`); 409 `already_claimed`;
410 expired; 504 verification timeout (order stays `issued`, retryable).

## Buyer side (how to pay)

From any Hedera wallet/SDK on **testnet**: submit a `ContractExecuteTransaction`
against `payTo` calling `tipPage("<payToUsername>")` with 5 HBAR and
**transaction memo = the exact `memo` from the bill**. Then POST the tx id to
`/api/a2a/paid`. HashPack testnet supports contract calls with memos; the
Hiero SDK path is `setTransactionMemo(memo)`.

## Configuration

`A2A_TESTNET_TIPS_ID` — the testnet Tips contract id (`0.0.x` form).
`A2A_RECIPIENT_USERNAME` — the ONE agent username buyers may pay
(Brandon's rule: buyers pay Blockpage Buddy itself; on mainnet `forge` —
the Buddy's wallet forwards profits to Brandon's wallet, to no one else).
Unset → the endpoints fail closed with 503. Mainnet ids are refused.

## Honest gaps (before mainnet)

1. **No testnet Tips contract is deployed.** There is no testnet key/HBAR in
   this environment, so the live end-to-end payment test is not yet possible.
   The verify path is fully implemented and tested against fixtures validated
   against the REAL testnet mirror-node response shapes (2026-09-15).
   Next step: fund a testnet account via the Hedera faucet, deploy
   `contracts/contracts/VoicescapeTips.sol` to testnet, set
   `A2A_TESTNET_TIPS_ID`, run a real 5 tHBAR payment through both endpoints.
2. **Claim registry + order store are in-memory** — move to Upstash (atomic
   claim) before mainnet.
3. **HCS audit log** of paid orders (design §10) not yet wired.
4. **fulfillOrder** exists for the delivery path; no delivery integration yet.
