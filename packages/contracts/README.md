# @voicescape/contracts

Voicescape's smart-contract layer: ABIs, addresses, `TxSender` factories, and
thin call wrappers for `VoicescapeRegistry` and `VoicescapeTips` on Hedera.

## Modules

- `abis.ts` — `REGISTRY_ABI`, `TIPS_ABI` (human-readable, verified against
  the Hardhat artifacts).
- `addresses.ts` — `getRegistryAddress()` / `getTipsAddress()` from env.
- `senders.ts` — `createEvmTxSender`, `createHederaTxSender`,
  `createReadOnlySender`. **This module pulls in `@hashgraph/sdk`
  (~2.3MB)** — it is dynamically imported by `@voicescape/wallet`, never
  statically bundled into the initial page load.
- `calls.ts` — `resolvePage`, `registerPage`, `updatePage`, `tipPage`,
  `buyListing`.

## Usage

```ts
import { resolvePage, tipPage, getTipsAddress } from "@voicescape/contracts";
import type { ChainConfig } from "@voicescape/wallet";

const page = await resolvePage("brandon", chain);
const txId = await tipPage("brandon", 1_000_000_000_000_000_000n, sender);
```

## Economics invariant

Tips and marketplace purchases route through the `VoicescapeTips` contract,
which splits **98% to the recipient / 2% to the treasury atomically
on-chain**. There is no escrow — the contract never holds user funds.

## Env

- `NEXT_PUBLIC_REGISTRY_ADDRESS` — VoicescapeRegistry EVM address
- `NEXT_PUBLIC_TIPS_ADDRESS` — VoicescapeTips EVM address

## Status

Extracted from the production monolith (`frontend/lib/tx.ts`,
`frontend/lib/contracts.ts`) during the modular refactor. The monolith still
uses its own copies; `apps/web` will switch to this package once the
migration lands.
