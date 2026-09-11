/**
 * SSE factory tests — real ReadableStream, stubbed poll function.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseStream, sinceParam } from "./sse";

afterEach(() => {
  vi.useRealTimers();
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stopWhen: (text: string) => boolean,
  maxReads = 10,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxReads; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (stopWhen(text)) break;
  }
  return text;
}

describe("createSseStream", () => {
  it("emits data: lines for polled events and advances the cursor", async () => {
    const events = [
      { seq: 1, body: "hello" },
      { seq: 2, body: "world" },
    ];
    const seen: number[] = [];
    const res = createSseStream(
      new AbortController().signal,
      async (afterSeq: number) => {
        seen.push(afterSeq);
        return events.filter((e) => e.seq > afterSeq);
      },
      0,
    );
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes('"seq":2'));
    await reader.cancel();
    expect(text).toContain('data: {"seq":1,"body":"hello"}');
    expect(text).toContain('data: {"seq":2,"body":"world"}');
    expect(seen).toEqual([0]);
  });

  it("respects the initial since cursor", async () => {
    const seen: number[] = [];
    const res = createSseStream(
      new AbortController().signal,
      async (afterSeq: number) => {
        seen.push(afterSeq);
        return [];
      },
      41,
    );
    const reader = res.body!.getReader();
    await reader.cancel();
    expect(seen).toEqual([41]);
  });

  it("keeps the stream alive when a poll throws", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const res = createSseStream(new AbortController().signal, async () => {
      calls++;
      throw new Error("mirror down");
    });
    const reader = res.body!.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(5000);
    const { done, value } = await pending;
    await reader.cancel();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toContain(": keepalive");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("closes the stream when the signal aborts", async () => {
    const ctrl = new AbortController();
    const res = createSseStream(ctrl.signal, async () => []);
    const reader = res.body!.getReader();
    const pending = reader.read();
    ctrl.abort();
    const { done } = await pending;
    expect(done).toBe(true);
  });
});

describe("sinceParam", () => {
  it("parses ?since= and defaults to 0", () => {
    expect(sinceParam("https://x.test/stream?since=12")).toBe(12);
    expect(sinceParam("https://x.test/stream")).toBe(0);
    expect(sinceParam("https://x.test/stream?since=abc")).toBe(0);
    expect(sinceParam("https://x.test/stream?since=-5")).toBe(0);
  });
});
