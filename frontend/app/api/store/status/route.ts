import { NextResponse } from "next/server";
import { getKvStore, storeBackendKind } from "@/lib/server/store";

export const runtime = "nodejs";

/**
 * GET /api/store/status → { backend, shared, reachable }
 *
 * Operational visibility: which shared-store backend this server instance
 * resolved, plus a live round-trip probe confirming the backend answers.
 *
 * Exposes only the backend KIND — never URLs, tokens, or connection details.
 * The probe is a single self-expiring key (60s TTL); it writes nothing
 * user-visible and costs one store op.
 *
 * Fail-soft: any unexpected error returns 200 with reachable: false rather
 * than a 500, so monitoring never breaks the page.
 */

const PROBE_KEY = "store:status-probe";
const PROBE_TTL_MS = 60_000;

export async function GET() {
  const backend = storeBackendKind();
  let reachable = false;
  try {
    const store = getKvStore();
    // setNx probe: true when this call created the key, false when it already
    // existed — either way the backend answered.
    await store.setNx(PROBE_KEY, String(Date.now()), PROBE_TTL_MS);
    reachable = true;
  } catch {
    reachable = false;
  }
  return NextResponse.json({
    backend,
    shared: backend !== "memory",
    reachable,
  });
}
