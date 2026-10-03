import { NextResponse } from "next/server";
import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";

/**
 * TEMPORARY DIAGNOSTIC (danny/wc-uri-debug, DO NOT SHIP).
 * Receives the WalletConnect pairing URI the dapp's modal displayed and
 * appends it to /tmp/wc-uri-debug.log for comparison against what the
 * wallet (HashPack) actually received.
 */
const LOG_PATH = "/tmp/wc-uri-debug.log";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { uri?: string; ts?: number };
    const line = `${new Date(body.ts ?? Date.now()).toISOString()} ${body.uri ?? "(no uri)"}\n`;
    // eslint-disable-next-line no-console
    console.log("[WC-DEBUG] received pairing URI:", body.uri);
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(LOG_PATH, line, "utf8");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
