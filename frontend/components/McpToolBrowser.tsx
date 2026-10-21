"use client";

import { useMemo, useState } from "react";

/**
 * MCP tool browser — the Inspector-shaped view of the public toolset.
 *
 * Left: searchable tool list. Right: inspector pane for the selected
 * tool — name, description, endpoint, and a copyable tools/call
 * envelope. Arguments are NOT fabricated here: the envelope shows the
 * tool name only, and the note points at tools/list for the real input
 * schema. Everything shown comes from the page's PUBLIC_TOOLS list,
 * which claims to match the registrations in app/api/mcp/route.ts.
 *
 * Presentation-only: no new dependency, no network calls, no wallet.
 */
export default function McpToolBrowser({
  tools,
  endpoint,
}: {
  tools: Array<[string, string]>;
  endpoint: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(tools[0]?.[0] ?? "");
  const [copied, setCopied] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      ([name, desc]) =>
        name.toLowerCase().includes(q) || desc.toLowerCase().includes(q),
    );
  }, [query, tools]);

  const current =
    filtered.find(([name]) => name === selected) ?? filtered[0] ?? null;

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(key);
    setTimeout(() => setCopied(null), 1600);
  }

  const callEnvelope = current
    ? JSON.stringify(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: current[0] },
        },
        null,
        2,
      )
    : "";

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search tools…"
        aria-label="Search MCP tools"
        style={{
          width: "100%",
          padding: "12px 16px",
          borderRadius: 12,
          border: "1px solid var(--vs-border)",
          background: "var(--vs-glass)",
          color: "var(--vs-text)",
          fontSize: 16,
          marginBottom: 12,
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)",
          gap: 12,
        }}
      >
        <div
          role="listbox"
          aria-label="MCP tools"
          style={{ display: "grid", gap: 6, alignContent: "start" }}
        >
          {filtered.length === 0 ? (
            <p style={{ color: "var(--vs-muted)", fontSize: 14 }}>
              No tools match “{query}”.
            </p>
          ) : (
            filtered.map(([name]) => {
              const active = current?.[0] === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => setSelected(name)}
                  style={{
                    textAlign: "left",
                    minHeight: 44,
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: active
                      ? "1px solid rgba(130, 89, 239, 0.55)"
                      : "1px solid var(--vs-border)",
                    background: active
                      ? "rgba(130, 89, 239, 0.14)"
                      : "var(--vs-glass)",
                    color: "var(--vs-text)",
                    fontFamily: "var(--vs-mono)",
                    fontSize: 13,
                    cursor: "pointer",
                    wordBreak: "break-all",
                  }}
                >
                  {name}
                </button>
              );
            })
          )}
        </div>
        <div
          style={{
            padding: 18,
            borderRadius: 12,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            minWidth: 0,
          }}
        >
          {current ? (
            <>
              <div
                style={{
                  fontFamily: "var(--vs-mono)",
                  fontSize: 15,
                  fontWeight: 700,
                  wordBreak: "break-all",
                  marginBottom: 8,
                }}
              >
                {current[0]}
              </div>
              <p
                style={{
                  color: "var(--vs-muted)",
                  fontSize: 14,
                  lineHeight: 1.6,
                  margin: "0 0 14px",
                }}
              >
                {current[1]}
              </p>
              <div
                style={{
                  fontFamily: "var(--vs-mono)",
                  fontSize: 12,
                  color: "var(--vs-muted)",
                  wordBreak: "break-all",
                  marginBottom: 6,
                }}
              >
                Endpoint: {endpoint}
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  fontFamily: "var(--vs-mono)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: 12,
                  borderRadius: 8,
                  background: "rgba(0, 0, 0, 0.35)",
                  border: "1px solid var(--vs-border)",
                  margin: "0 0 8px",
                  overflowX: "auto",
                }}
              >
                {callEnvelope}
              </pre>
              <p
                style={{
                  color: "var(--vs-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  margin: "0 0 12px",
                }}
              >
                Arguments are not shown here — fetch the real input schema
                with tools/list before calling. No auth for public tools.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void copy(current[0], "name")}
                  style={{
                    minHeight: 44,
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: "1px solid rgba(130, 89, 239, 0.4)",
                    background: "transparent",
                    color: "var(--vs-text)",
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {copied === "name" ? "Copied ✓" : "Copy tool name"}
                </button>
                <button
                  type="button"
                  onClick={() => void copy(endpoint, "endpoint")}
                  style={{
                    minHeight: 44,
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: "1px solid rgba(130, 89, 239, 0.4)",
                    background: "transparent",
                    color: "var(--vs-text)",
                    fontSize: 12.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {copied === "endpoint" ? "Copied ✓" : "Copy endpoint"}
                </button>
              </div>
            </>
          ) : (
            <p style={{ color: "var(--vs-muted)", fontSize: 14 }}>
              Select a tool to inspect it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
