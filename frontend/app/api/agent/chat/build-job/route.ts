/**
 * POST /api/agent/chat/build-job — async paid-build jobs for Blockpage Buddy.
 *
 * The paid build (LLM page generation + AI artwork + IPFS pin) exceeds the
 * ~60s serverless execution window, so the chat route hands the widget a
 * signed job-start token on the "go" turn and the widget drives the build
 * here instead:
 *
 *   {action:"start", token} -> {jobId, step}            (idempotent resume)
 *   {action:"step", jobId}  -> {done:false, step, progress, note} | {done:true, draft}
 *
 * The payment is consumed exactly once, only in the finalize step after a
 * valid draft exists — failed attempts never consume. Requires a signed-in
 * wallet session on every call; the job's wallet must match the session.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  agentChatClientIp,
  agentChatRateLimited,
} from "@/lib/agent/rate-limit";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { startBuildJob, stepBuildJob } from "./job";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (agentChatRateLimited(agentChatClientIp(req))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Builds need a wallet — anonymous visitors are stopped at the paywall
  // in chat and can never reach this route with a valid token.
  const cred = sessionCredentialFrom(req);
  const verified = typeof cred === "string" ? verifySessionToken(cred) : null;
  if (!verified || !verified.ok) {
    return NextResponse.json({ error: "signed_in_required" }, { status: 401 });
  }
  const wallet = verified.session.address as string;

  const action = body?.action;
  if (action === "start") {
    const result = await startBuildJob(body?.token, wallet);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, reason: result.reason ?? null },
        { status: 200 }
      );
    }
    return NextResponse.json({
      jobId: result.jobId,
      step: result.step,
      resumed: result.resumed,
      progress: 0.1,
      note: "Starting your build…",
    });
  }

  if (action === "step") {
    const jobId = typeof body?.jobId === "string" ? body.jobId : "";
    if (!jobId) {
      return NextResponse.json({ error: "job_id_required" }, { status: 400 });
    }
    const result = await stepBuildJob(jobId, wallet, {
      clientIp: agentChatClientIp(req),
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, reason: result.reason ?? null },
        { status: 200 }
      );
    }
    if (result.done) {
      return NextResponse.json({
        done: true,
        draft: result.draft,
        note: result.note,
      });
    }
    return NextResponse.json({
      done: false,
      step: result.step,
      progress: result.progress,
      note: result.note,
    });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
