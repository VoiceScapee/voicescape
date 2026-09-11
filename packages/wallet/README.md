# @voicescape/wallet

Voicescape's wallet connection layer. One interface, multiple adapters:

- **Hedera** (HashPack, Blade, WalletConnect): paired through `DAppConnector`
  from `@hashgraph/hedera-wallet-connect` (official, HIP-820 based).
- **MetaMask**: injected `window.ethereum` + ethers v6, auto-switches to Hedera.

## Usage

```tsx
import { WalletProvider, useWallet, WALLET_ADAPTERS } from "@voicescape/wallet";

function App() {
  return (
    <WalletProvider>
      <ConnectButton />
    </WalletProvider>
  );
}

function ConnectButton() {
  const { account, connect, disconnect, isConnecting, error } = useWallet();
  // ...
}
```

## Design notes

- The `@hashgraph/sdk` (~2.3MB) is **never** statically imported here. The
  concrete `TxSender` factories live in `@voicescape/contracts` and are
  dynamically imported only when signing — this keeps the wallet connection
  chunk small and avoids mobile ChunkLoadError failures.
- `MinimalLedgerId` shim replaces the SDK's `LedgerId` (DAppConnector only
  calls `toString()` on it).
- Inside HashPack's in-app browser the provider auto-connects on mount (the
  QR modal is skipped); the 7-day login signature is still required by the
  session layer.

## Env

- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — free at https://cloud.reown.com

## Status

Extracted from the production monolith (`frontend/lib/wallet.tsx`) during the
modular refactor. The monolith still uses its own copy; `apps/web` will switch
to this package once the migration lands.
