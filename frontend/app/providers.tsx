"use client";

/**
 * Client-side providers mounted once at the root layout:
 * WalletProvider (connection) → SessionProvider (sign-in).
 *
 * Pages that previously wrapped themselves in their own WalletProvider keep
 * working — nested providers are harmless — but new code should rely on the
 * root providers and just call useWallet() / useSession().
 */

import React from "react";
import { WalletProvider } from "@/lib/wallet";
import { SessionProvider } from "@/lib/session";

export function RootProviders({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <SessionProvider>{children}</SessionProvider>
    </WalletProvider>
  );
}
