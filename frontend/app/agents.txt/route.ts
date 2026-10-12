import { readFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";

/**
 * GET /agents.txt — plain-text entrypoint for AI agents.
 *
 * Served by a route (not just public/) because the dynamic [username]
 * route would otherwise claim "/agents.txt" as a blockpage lookup.
 * Same pattern as app/agents.md/route.ts.
 */
export async function GET() {
  try {
    const filePath = join(process.cwd(), "public", "agents.txt");
    const content = await readFile(filePath, "utf-8");
    return new NextResponse(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
