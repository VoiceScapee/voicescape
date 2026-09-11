# marketplace/

Marketplace listings in Voicescape are **not** a separate contract.

Listings are created off-chain (town-hall HCS topics) and purchased through
`VoicescapeTips.buyListing(address seller, string listingRef)` in
`../tips/VoicescapeTips.sol` — one atomic transaction that splits 98% to the
seller and 2% to the treasury, with zero retained balance (no escrow).

## Why no separate marketplace contract?

Brandon's no-custody rule: the platform never holds user funds — only the fee
it is paid. A standalone marketplace contract would need escrow (holding buyer
funds until delivery), which violates the rule. The direct-sale-via-Tips
design is the minimal Hedera-native solution:

1. Buyer calls `buyListing(seller, listingRef)` with HBAR attached.
2. Contract sends 98% → seller, 2% → treasury, in the same transaction.
3. Delivery happens off-chain; trust comes from the public completed-purchase
   record (HCS audit feed).

If a future design needs on-chain listing state (e.g. for the rewards
contract), it goes here.
