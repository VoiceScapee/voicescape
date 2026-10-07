/**
 * POST /api/widget-visit tests — frozen beacon spec (2026-10-07).
 *
 * The beacon shape is {wid, iid}. Both fields are REQUIRED:
 * - missing/empty iid is a hard 400 (MISSING_IID), not a quiet null
 * - invalid wid is a hard 400 (INVALID_WID)
 * - unissued wid is a hard 400 (UNKNOWN_WID)
 */
import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { resetKvStoreSingleton } from "@/lib/server/store";
import {
  logWidgetIssued,
  mintWidgetId,
} from "@/lib/server/widget-diagnostics";
import { POST } from "./route";
import { WIDGET_VISIT_ERRORS } from "@/lib/server/widget-beacon";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/widget-visit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetKvStoreSingleton();
});

describe("frozen beacon spec: {wid, iid}", () => {
  it("accepts a valid {wid, iid} beacon", async () => {
    const wid = mintWidgetId();
    await logWidgetIssued(wid);
    const res = await POST(postReq({ wid, iid: "req-123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("hard-fails on missing iid (MISSING_IID)", async () => {
    const wid = mintWidgetId();
    await logWidgetIssued(wid);
    const res = await POST(postReq({ wid }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("MISSING_IID");
    expect(body.message).toBe(WIDGET_VISIT_ERRORS.MISSING_IID);
  });

  it("hard-fails on empty iid", async () => {
    const wid = mintWidgetId();
    await logWidgetIssued(wid);
    const res = await POST(postReq({ wid, iid: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("MISSING_IID");
  });

  it("hard-fails on non-string iid", async () => {
    const wid = mintWidgetId();
    await logWidgetIssued(wid);
    const res = await POST(postReq({ wid, iid: 12345 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("MISSING_IID");
  });

  it("hard-fails on oversized iid", async () => {
    const wid = mintWidgetId();
    await logWidgetIssued(wid);
    const res = await POST(postReq({ wid, iid: "x".repeat(129) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("MISSING_IID");
  });

  it("hard-fails on invalid wid (INVALID_WID)", async () => {
    const res = await POST(postReq({ wid: "nope", iid: "req-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_WID");
  });

  it("hard-fails on unissued wid (UNKNOWN_WID)", async () => {
    const wid = mintWidgetId(); // valid format, never issued
    const res = await POST(postReq({ wid, iid: "req-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("UNKNOWN_WID");
  });

  it("hard-fails on missing wid", async () => {
    const res = await POST(postReq({ iid: "req-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_WID");
  });

  it("error codes are stable strings (beacon shape stability)", () => {
    // autonomaavalix builds assert-on-ingest checks against these.
    // If you rename a code, bump the spec version and notify consumers.
    expect(Object.keys(WIDGET_VISIT_ERRORS).sort()).toEqual([
      "INVALID_WID",
      "MISSING_IID",
      "UNKNOWN_WID",
    ]);
  });
});
