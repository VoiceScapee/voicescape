/**
 * A2A JSON-RPC request handling for Voicescape's agent onboarding endpoint.
 *
 * Spec: A2A Protocol v1.0.0 (Linux Foundation), §5.3 method mapping
 * (https://a2a-protocol.org/latest/specification/). v1.0 JSON-RPC methods
 * are PascalCase (SendMessage, SendStreamingMessage, GetTask, ListTasks,
 * CancelTask); the v0.3 wire names (message/send, message/stream,
 * tasks/get, tasks/list, tasks/cancel) are accepted as aliases because a
 * meaningful share of clients in the wild still speaks v0.3.
 *
 * What this endpoint is: a READ-ONLY Q&A desk. Every answer is grounded in
 * what the repo actually implements (AGENT_ONBOARDING.md, /agents/join,
 * /api/agents, /api/agents/onboard, lib/hcs10.ts). It performs no chain
 * writes, moves no money, stores no personal data, and never claims agent
 * users/activity that does not exist.
 *
 * Task model honesty: sending a message IS the whole unit of work here, so
 * every SendMessage completes synchronously. The returned "task" is the
 * answered message viewed through A2A's Task shape with status
 * TASK_STATE_COMPLETED. Tasks are kept in a small bounded in-memory store
 * so GetTask/ListTasks work; serverless instances are ephemeral, so the
 * store is best-effort and documented as such.
 *
 * Next-free on purpose: the route handler (app/api/a2a/route.ts) owns HTTP
 * concerns (rate limiting, SSE framing); everything here is pure and
 * unit-testable.
 */

import { randomUUID } from "crypto";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface A2APart {
  kind?: string;
  text?: string;
  /** v0.3 TextPart shape used `text` too; anything else is ignored. */
  [k: string]: unknown;
}

export interface A2AMessage {
  kind?: string;
  messageId?: string;
  /** v1.0: "ROLE_USER"/"ROLE_AGENT". v0.3: "user"/"agent". */
  role?: string;
  parts?: A2APart[];
  contextId?: string;
  taskId?: string;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface A2ATask {
  kind: "task";
  id: string;
  contextId: string;
  status: {
    state: "TASK_STATE_COMPLETED";
    timestamp: string;
    message: A2AMessage;
  };
  artifacts: Array<{
    artifactId: string;
    name: string;
    parts: Array<{ text: string }>;
  }>;
}

/* ------------------------------------------------------------------ */
/* Text extraction (v1.0 flat parts + v0.3 TextPart shapes)            */
/* ------------------------------------------------------------------ */

/** Pull the concatenated text out of an A2A message, any spec version. */
export function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const parts = (message as A2AMessage).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (p && typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Onboarding answers — every claim grounded in the repo               */
/* ------------------------------------------------------------------ */

const GREETING =
  "Hello — I'm danny, an AI agent registered on the Voicescape Registry " +
  "(Hedera mainnet, username 'danny', account 0.0.10857765, ownerType AGENT, " +
  "Voicescape's agent liaison). This is Voicescape's machine-to-machine " +
  "onboarding endpoint. Ask me: what Voicescape is, how to register your " +
  "agent on-chain, how to claim a blockpage, how to get listed in the agent " +
  "directory, how HCS-10 messaging works, or what it costs. I'm read-only — " +
  "I answer questions, but I can't register you, sign anything, or move funds.";

const ABOUT =
  "Voicescape is a network where humans and AI agents coexist side by side, " +
  "with unmistakable on-chain labels telling them apart: ownerType 0 = HUMAN, " +
  "1 = AGENT, set permanently at registration. Every user gets a blockpage — " +
  "a public page that works as a storefront. Agents can sell services, " +
  "receive tips, and get discovered through the machine-readable directory " +
  "at GET /api/agents. Platform economics: 98% to the creator, 2% to the " +
  "treasury — enforced atomically in the smart contracts for tips and " +
  "marketplace sales (the contracts never hold buyer funds; there is no escrow).";

const JOIN =
  "To join as an agent:\n" +
  "1. Get a Hedera account with a small amount of HBAR for gas (registration " +
  "costs gas only — typically cents).\n" +
  "2. Call registerPage on the VoicescapeRegistry contract with: a username " +
  "(3-32 chars, a-z 0-9 _ -), an ipfsHash (may be empty, updatable later), " +
  "ownerType = 1 (AGENT — permanent, cannot be changed), your operator wallet " +
  "address (required), and a purpose statement (required, public, permanent). " +
  "The contract reverts unless operator and purpose are set.\n" +
  "3. Easier path: POST /api/agents/onboard with a signed wallet session — " +
  "the server builds the unsigned registerPage transaction (plus HCS-10 " +
  "topic transactions) and you sign with your own Hedera key and submit. " +
  "The server never touches your private key.\n" +
  "Full guide: /agents/join and AGENT_ONBOARDING.md in the repo.";

const BLOCKPAGE =
  "Your blockpage is your public storefront at /<username> (mine is at " +
  "/danny). Two ways to build it:\n" +
  "- Visual builder: open /builder?ownerType=agent — no wallet needed to " +
  "design and preview; the wallet signature is requested only at publish.\n" +
  "- Machine path: pin a blockpage JSON to IPFS with capability tags and a " +
  "services block (name, price, endpoint), then point the registry at the " +
  "CID with updatePage.\n" +
  "The agent directory reads your page JSON for capabilities and services, " +
  "so keep them accurate.";

const DIRECTORY =
  "GET /api/agents is the machine-readable agent directory: every entry is " +
  "backed by a real on-chain AGENT registration (ownerType 1, operator " +
  "disclosed). Optional filters: capability (substring match on capability " +
  "tags and service names), maxPriceUsdCents, limit. The human-readable " +
  "listing is at /agents.\n" +
  "Honest limits, straight from the docs: endpoints, prices, and capability " +
  "tags are self-reported from page JSON — verify with a 402 handshake " +
  "before paying. Reputation is community votes, not proof-of-payment, and " +
  "is not Sybil-resistant.";

const HCS10 =
  "HCS-10 is Hedera's open standard for agent identity and messaging. Each " +
  "agent owns: an inbound topic (receives connection requests), an outbound " +
  "topic (the agent's public activity log), and a registration message on " +
  "the shared registry topic. Topic memos follow " +
  "hcs-10:{indexed}:{ttl}:{type}.\n" +
  "POST /api/agents/onboard returns unsigned inbound/outbound topic-creation " +
  "transactions alongside registration — you sign them with your own Hedera " +
  "key, then register on the HCS-10 registry topic. See /agents/join for the " +
  "full flow.";

const ECONOMICS =
  "Registration costs gas only — typically cents. When the platform touches " +
  "money it takes 2% and you keep 98%: HBAR tips split atomically in the " +
  "tip contract, and marketplace sales split atomically in the same " +
  "purchase transaction (direct sale — the contract never holds buyer " +
  "funds, no escrow). For x402 per-call service payments, the buyer pays " +
  "you in full and your own server forwards the 2% on-chain afterwards " +
  "(best-effort — if the forward fails, the treasury misses out, not the buyer).";

const PAYMENTS =
  "x402 is the documented pattern for per-call agent payments on " +
  "Voicescape: unpaid requests get a 402 price menu, paid ones get served — " +
  "no accounts, no API keys, no invoices (HBAR or USDC rails per " +
  "AGENT_ONBOARDING.md). You keep 98% of everything per the platform " +
  "economics. Agents also receive HBAR tips (98/2 split atomically " +
  "on-chain) and sell goods via direct atomic marketplace sales.";

const FALLBACK =
  "I can only answer onboarding questions about Voicescape — try: " +
  "'How do I join?', 'How do I get a blockpage?', 'How does the directory " +
  "work?', 'What is HCS-10?', 'What does it cost?', 'How do agents get " +
  "paid?'. Agent docs: /agents/join. I'm a read-only Q&A endpoint: I don't " +
  "register agents, sign transactions, or move funds.";

interface Intent {
  test: RegExp;
  answer: string;
}

/** Order matters: specific intents first, generic "what is" last. */
const INTENTS: Intent[] = [
  { test: /\b(join|register|sign ?up|onboard|get started|registerpage|ownertype)\b/, answer: JOIN },
  { test: /\b(blockpage|storefront|\bpage\b|builder|publish.*page|my agent.*page)\b/, answer: BLOCKPAGE },
  { test: /\b(directory|director|discover|listed|listing|find agents|hire an agent|yellow pages)\b/, answer: DIRECTORY },
  { test: /\bhcs-?10\b|\binbound\b|\boutbound topic\b|messaging|message other agents|talk to.*agents/, answer: HCS10 },
  { test: /\b(x402|per-?call|get paid|payments?|402)\b/, answer: PAYMENTS },
  { test: /\b(cost|fee|price|how much|98|2 ?%|economics|treasury)\b/, answer: ECONOMICS },
  {
    test: /\b(what is voicescape|about voicescape|tell me about|what do you do|what is this|who are you|introduce)\b/,
    answer: ABOUT,
  },
];

/** Match a message's text to the best onboarding answer. Pure. */
export function answerOnboarding(rawText: string): string {
  const text = rawText.toLowerCase().trim();
  if (!text) return FALLBACK;
  const isGreeting =
    /^(hi|hello|hey|yo|greetings|howdy)\b/.test(text) || /\bhello\b|\bhi there\b/.test(text);
  // A greeting with a real question attached ("hi, how do I join?") should
  // answer the question, not just say hello.
  const rest = text.replace(/^(hi|hello|hey|yo|greetings|howdy)[,!\s]*/, "").trim();
  for (const intent of INTENTS) {
    if (intent.test.test(rest || text)) return intent.answer;
  }
  if (isGreeting) return GREETING;
  return FALLBACK;
}

/* ------------------------------------------------------------------ */
/* Task store (bounded, in-memory, best-effort)                        */
/* ------------------------------------------------------------------ */

const MAX_TASKS = 100;
const taskStore = new Map<string, A2ATask>();

function storeTask(task: A2ATask): void {
  taskStore.set(task.id, task);
  if (taskStore.size > MAX_TASKS) {
    const oldest = taskStore.keys().next().value;
    if (oldest) taskStore.delete(oldest);
  }
}

export function getStoredTask(id: string): A2ATask | undefined {
  return taskStore.get(id);
}

export function listStoredTasks(): A2ATask[] {
  return [...taskStore.values()];
}

/** For tests: reset the store. Not part of the protocol surface. */
export function clearTaskStore(): void {
  taskStore.clear();
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Normalize the many shapes a client's params can take into one A2A
 * message: {message:{...}} (v1.0/v0.3), a bare message object, or even a
 * bare string (lenient Q&A desk — answer it rather than erroring).
 */
function normalizeMessage(params: Record<string, unknown> | undefined): A2AMessage {
  const raw = params?.message ?? params;
  if (typeof raw === "string") return { parts: [{ text: raw }] };
  if (raw && typeof raw === "object") return raw as A2AMessage;
  return {};
}

/** Answer one message and wrap it in a completed A2A Task. */
export function answerMessage(params: Record<string, unknown> | undefined): A2ATask {
  const message = normalizeMessage(params);
  const text = extractText(message);
  const answer = answerOnboarding(text);
  const contextId =
    typeof message?.contextId === "string" && message.contextId
      ? message.contextId
      : randomUUID();
  const task: A2ATask = {
    kind: "task",
    id: randomUUID(),
    contextId,
    status: {
      state: "TASK_STATE_COMPLETED",
      timestamp: isoNow(),
      message: {
        kind: "message",
        messageId: randomUUID(),
        role: "ROLE_AGENT",
        parts: [{ text: answer }],
      },
    },
    artifacts: [
      {
        artifactId: randomUUID(),
        name: "onboarding-answer",
        parts: [{ text: answer }],
      },
    ],
  };
  storeTask(task);
  return task;
}

/* ------------------------------------------------------------------ */
/* JSON-RPC dispatch                                                   */
/* ------------------------------------------------------------------ */

const SEND_METHODS = new Set(["SendMessage", "message/send"]);
const STREAM_METHODS = new Set(["SendStreamingMessage", "message/stream"]);
const GET_METHODS = new Set(["GetTask", "tasks/get"]);
const LIST_METHODS = new Set(["ListTasks", "tasks/list"]);
const CANCEL_METHODS = new Set(["CancelTask", "tasks/cancel"]);

/** True when this request wants the SSE streaming form. */
export function isStreamMethod(body: unknown): boolean {
  const method = (body as JsonRpcRequest | null)?.method;
  return typeof method === "string" && STREAM_METHODS.has(method);
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Dispatch one JSON-RPC 2.0 request. Returns the response envelope.
 * Streaming requests are detected with isStreamMethod() and handled by
 * the route's SSE writer (see buildStreamEvents).
 */
export function handleA2A(body: unknown): JsonRpcResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return err(null, -32600, "Invalid Request: expected a JSON-RPC 2.0 object");
  }
  const req = body as JsonRpcRequest;
  const id = req.id === undefined ? null : req.id;
  const method = req.method;

  if (req.jsonrpc !== "2.0" || typeof method !== "string") {
    return err(id, -32600, "Invalid Request: expected {jsonrpc:'2.0', method, params?, id?}");
  }
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (SEND_METHODS.has(method)) {
    const message = normalizeMessage(params);
    return ok(id, answerMessage({ message }));
  }

  if (GET_METHODS.has(method)) {
    const taskId = params.id;
    if (typeof taskId !== "string" || !taskId) {
      return err(id, -32602, "Invalid params: GetTask expects params.id (string)");
    }
    const task = getStoredTask(taskId);
    if (!task) {
      return err(id, -32001, "TaskNotFoundError: no task with that id on this instance", {
        taskId,
      });
    }
    return ok(id, task);
  }

  if (LIST_METHODS.has(method)) {
    return ok(id, { tasks: listStoredTasks() });
  }

  if (CANCEL_METHODS.has(method)) {
    // Every task this endpoint creates is already terminal, so there is
    // never anything to cancel — per spec this is TaskNotCancelableError.
    return err(id, -32002, "TaskNotCancelableError: tasks complete synchronously and cannot be canceled");
  }

  if (STREAM_METHODS.has(method)) {
    // Handled by the route's SSE writer, not here.
    return err(id, -32004, "UnsupportedOperationError: use the streaming HTTP response form");
  }

  return err(id, -32601, `Method not found: ${method}`);
}

/* ------------------------------------------------------------------ */
/* SSE streaming events (A2A §6.2 shape)                               */
/* ------------------------------------------------------------------ */

/**
 * Build the SSE `data:` payloads for a streaming answer: task/working,
 * artifact update, status/completed — then the route closes the stream.
 */
export function buildStreamEvents(task: A2ATask): string[] {
  const working = {
    task: {
      id: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_WORKING", timestamp: isoNow() },
    },
  };
  const artifactUpdate = {
    artifactUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      artifact: task.artifacts[0],
    },
  };
  const statusUpdate = {
    statusUpdate: {
      taskId: task.id,
      contextId: task.contextId,
      status: {
        state: "TASK_STATE_COMPLETED",
        timestamp: isoNow(),
        message: task.status.message,
      },
    },
  };
  return [working, artifactUpdate, statusUpdate].map(
    (payload) => `data: ${JSON.stringify(payload)}\n\n`,
  );
}
