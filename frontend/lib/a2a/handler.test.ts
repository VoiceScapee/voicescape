/**
 * A2A handler tests: intent matching for the core onboarding questions and
 * JSON-RPC dispatch for both v1.0 and legacy v0.3 method names.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  answerOnboarding,
  buildStreamEvents,
  clearTaskStore,
  extractText,
  getStoredTask,
  handleA2A,
  isStreamMethod,
  listStoredTasks,
} from "./handler";

beforeEach(() => {
  clearTaskStore();
});

function sendMessage(text: string, method = "SendMessage") {
  return {
    jsonrpc: "2.0",
    id: "req-1",
    method,
    params: {
      message: {
        kind: "message",
        messageId: "m-1",
        role: "ROLE_USER",
        parts: [{ text }],
      },
    },
  };
}

describe("extractText", () => {
  it("reads v1.0 flat parts", () => {
    expect(extractText({ parts: [{ text: "hello" }] })).toBe("hello");
  });

  it("reads v0.3 TextPart shapes", () => {
    expect(extractText({ parts: [{ kind: "text", text: "hi" }] })).toBe("hi");
  });

  it("joins multiple parts and ignores non-text parts", () => {
    expect(extractText({ parts: [{ text: "a" }, { kind: "file" }, { text: "b" }] })).toBe("a\nb");
  });

  it("returns empty string for malformed input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
  });
});

describe("answerOnboarding intents", () => {
  it("greets", () => {
    expect(answerOnboarding("hello")).toMatch(/Echo/);
    expect(answerOnboarding("hi there")).toMatch(/machine-to-machine/);
  });

  it("answers a greeting with a question attached by answering the question", () => {
    expect(answerOnboarding("hi, how do I join?")).toMatch(/registerPage/);
  });

  it("explains how to join (registerPage, ownerType=1)", () => {
    const a = answerOnboarding("How do I join Voicescape as an agent?");
    expect(a).toMatch(/registerPage/);
    expect(a).toMatch(/ownerType *= *1/);
    expect(a).toMatch(/\/api\/agents\/onboard/);
  });

  it("explains blockpages via the builder", () => {
    const a = answerOnboarding("How do I get a blockpage?");
    expect(a).toMatch(/\/builder/);
    expect(a).toMatch(/updatePage/);
  });

  it("explains the directory", () => {
    const a = answerOnboarding("How does the agent directory work?");
    expect(a).toMatch(/\/api\/agents/);
    expect(a).toMatch(/self-reported/);
  });

  it("explains HCS-10", () => {
    const a = answerOnboarding("What is HCS-10?");
    expect(a).toMatch(/inbound/);
    expect(a).toMatch(/outbound/);
  });

  it("explains costs honestly (gas only, 98/2)", () => {
    const a = answerOnboarding("What does it cost?");
    expect(a).toMatch(/gas only/);
    expect(a).toMatch(/98%/);
  });

  it("explains payments", () => {
    const a = answerOnboarding("How do agents get paid?");
    expect(a).toMatch(/x402/);
  });

  it("falls back honestly on unknown input", () => {
    const a = answerOnboarding("blorptastic quantum waffles");
    expect(a).toMatch(/read-only/);
    expect(a).toMatch(/\/agents\/join/);
  });

  it("falls back on empty input", () => {
    expect(answerOnboarding("   ")).toMatch(/read-only/);
  });
});

describe("handleA2A dispatch", () => {
  it("SendMessage returns a completed task with the answer", () => {
    const res = handleA2A(sendMessage("How do I join?"));
    expect(res.jsonrpc).toBe("2.0");
    expect(res.error).toBeUndefined();
    const task = res.result as { kind: string; status: { state: string } };
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(JSON.stringify(task)).toMatch(/registerPage/);
  });

  it("accepts the legacy v0.3 message/send name", () => {
    const res = handleA2A(sendMessage("hello", "message/send"));
    const task = res.result as { status: { state: string } };
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(JSON.stringify(task)).toMatch(/Echo/);
  });

  it("answers with the fallback when params.message is missing (lenient Q&A desk)", () => {
    const res = handleA2A({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} });
    expect(res.error).toBeUndefined();
    expect(JSON.stringify(res.result)).toMatch(/read-only/);
  });

  it("GetTask retrieves a task created by SendMessage", () => {
    const sent = handleA2A(sendMessage("hi"));
    const task = sent.result as { id: string };
    const got = handleA2A({ jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: task.id } });
    expect(got.error).toBeUndefined();
    expect((got.result as { id: string }).id).toBe(task.id);
  });

  it("accepts the legacy tasks/get name", () => {
    const sent = handleA2A(sendMessage("hi"));
    const task = sent.result as { id: string };
    const got = handleA2A({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: task.id } });
    expect((got.result as { id: string }).id).toBe(task.id);
  });

  it("GetTask on an unknown id returns TaskNotFoundError (-32001)", () => {
    const res = handleA2A({
      jsonrpc: "2.0",
      id: 3,
      method: "GetTask",
      params: { id: "nope" },
    });
    expect(res.error?.code).toBe(-32001);
  });

  it("ListTasks returns created tasks", () => {
    handleA2A(sendMessage("hi"));
    const res = handleA2A({ jsonrpc: "2.0", id: 4, method: "ListTasks", params: {} });
    const tasks = (res.result as { tasks: unknown[] }).tasks;
    expect(tasks.length).toBeGreaterThan(0);
    expect(listStoredTasks().length).toBe(tasks.length);
  });

  it("CancelTask on a completed task returns TaskNotCancelableError (-32002)", () => {
    const sent = handleA2A(sendMessage("hi"));
    const task = sent.result as { id: string };
    const res = handleA2A({
      jsonrpc: "2.0",
      id: 5,
      method: "CancelTask",
      params: { id: task.id },
    });
    expect(res.error?.code).toBe(-32002);
  });

  it("unknown methods return -32601", () => {
    const res = handleA2A({ jsonrpc: "2.0", id: 6, method: "DoTheThing", params: {} });
    expect(res.error?.code).toBe(-32601);
  });

  it("non-object bodies return -32600", () => {
    expect(handleA2A(null).error?.code).toBe(-32600);
    expect(handleA2A([1, 2]).error?.code).toBe(-32600);
    expect(handleA2A({ method: "SendMessage" }).error?.code).toBe(-32600);
  });

  it("stores tasks for later retrieval", () => {
    const sent = handleA2A(sendMessage("directory?"));
    const task = sent.result as { id: string };
    expect(getStoredTask(task.id)?.id).toBe(task.id);
  });
});

describe("streaming", () => {
  it("detects stream methods", () => {
    expect(isStreamMethod({ method: "SendStreamingMessage" })).toBe(true);
    expect(isStreamMethod({ method: "message/stream" })).toBe(true);
    expect(isStreamMethod({ method: "SendMessage" })).toBe(false);
  });

  it("builds the A2A working → artifact → completed event sequence", () => {
    const sent = handleA2A(sendMessage("hi"));
    const task = sent.result as Parameters<typeof buildStreamEvents>[0];
    const events = buildStreamEvents(task);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatch(/TASK_STATE_WORKING/);
    expect(events[1]).toMatch(/artifactUpdate/);
    expect(events[2]).toMatch(/TASK_STATE_COMPLETED/);
    for (const e of events) {
      expect(e.startsWith("data: ")).toBe(true);
      expect(e.endsWith("\n\n")).toBe(true);
      // Each payload must be valid JSON.
      expect(() => JSON.parse(e.replace(/^data: /, ""))).not.toThrow();
    }
  });
});
