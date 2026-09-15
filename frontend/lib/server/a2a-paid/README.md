# Paid agent endpoint — testnet prototype (Phase 5)

**Status:** TESTNET ONLY. Incapable of touching mainnet by construction
(see `config.ts`: hardcoded testnet mirror, mainnet contract ids rejected,
`0.0.x`-only contract ids).

## Endpoints

- `POST /api/a2a/orders` — body `{ product: "chat-50" | "blockpage-build", buyerAccount: "0.0.x" }`.
  Testnet mirror balance pre-check (≥ 5.5 HBAR). Success → **HTTP 402** + bill:
  `{ orderId, priceHbar: 5, payTo, function: "tipPage", memo: "vs-order:<orderId>", expiresAt }`.
- `POST /api/a2a/paid` — body `{ orderId, txId }`. Verifies via the TESTNET
  mirror node and returns `{ entitlement }` exactly once.

## Verification rules (`verify.ts`)

All must hold: tx `SUCCESS`, `entity_id` == Tips contract, memo contains the
exact order memo, contract result `0x1` + `to` == Tips contract + `tipPage`
selector (`0x8b0de5cb`) + amount ≥ 5 HBAR, tx never claimed before.
Failures: 422 with a specific code (`tx_failed`, `wrong_contract`,
`memo_mismatch`, `wrong_function`, `underpaid`); 409 `already_claimed`;
410 expired; 504 verification timeout (order stays `issued`, retryable).

## Buyer side (how to pay)

From any Hedera wallet/SDK on **testnet**: submit a `ContractExecuteTransaction`
against `payTo` calling `tipPage(string)` with 5 HBAR and
**transaction memo = the exact `memo` from the bill**. Then POST the tx id to
`/api/a2a/paid`. HashPack testnet supports contract calls with memos; the
Hiero SDK path is `setTransactionMemo(memo)`.

## Configuration

`A2A_TESTNET_TIPS_ID` — the testnet Tips contract id (`0.0.x` form).
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
