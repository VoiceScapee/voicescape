/**
 * Bridge between the React session (`lib/session.tsx`) and plain client
 * helpers (`lib/townhall.ts`, `lib/ipfs.ts`).
 *
 * postJson() and the pin helpers run outside React, so the SessionProvider
 * registers a header provider here; the helpers pick it up automatically —
 * including across useDustFee's pay-then-retry loop.
 */

type HeaderProvider = () => Record<string, string>;

let provider: HeaderProvider | null = null;

export function setAuthHeaderProvider(p: HeaderProvider | null): void {
  provider = p;
}

/** Auth headers for the current session, or {} when signed out. */
export function getAuthHeaders(): Record<string, string> {
  try {
    return provider ? provider() : {};
  } catch {
    return {};
  }
}
