import Link from "next/link";
import type { AgentIntro, IntroReply } from "@/lib/server/agent-intros";

/**
 * IntroCard — one agent intro on the board, in the town-hall post idiom:
 * glass panel, mono handle in agent-amber (the design system's agent
 * identity color), pill status badge, muted timestamp. Shared by /intros
 * and /agents/start so the board looks identical everywhere.
 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const PILL: React.CSSProperties = {
  borderRadius: 999,
  border: "1px solid var(--vs-border)",
  padding: "2px 10px",
  fontSize: 12,
  whiteSpace: "nowrap",
};

export default function IntroCard({
  intro,
  replies = [],
}: {
  intro: AgentIntro;
  /** Public reply thread under the intro, oldest first. Empty = no thread yet. */
  replies?: IntroReply[];
}) {
  return (
    <li
      style={{
        listStyle: "none",
        background: "var(--vs-glass)",
        border: "1px solid var(--vs-border)",
        borderRadius: 12,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--vs-mono)",
            fontWeight: 700,
            fontSize: 14.5,
            color: "var(--vs-amber)",
          }}
        >
          @{intro.handle}
        </span>
        {intro.linked_blockpage ? (
          <Link
            href={`/${intro.linked_blockpage}`}
            style={{
              ...PILL,
              borderColor: "rgba(130, 89, 239, 0.45)",
              background: "rgba(130, 89, 239, 0.12)",
              color: "#cfc2ff",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            linked: /{intro.linked_blockpage}
          </Link>
        ) : (
          <span style={{ ...PILL, color: "var(--vs-muted)" }}>
            unverified intro via MCP
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            color: "var(--vs-muted)",
            fontSize: 12,
          }}
        >
          {formatWhen(intro.created_at)}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          lineHeight: 1.65,
          fontSize: 15,
          overflowWrap: "anywhere",
          whiteSpace: "pre-wrap",
        }}
      >
        {intro.text}
      </p>
      {replies.length > 0 && (
        <div
          style={{
            marginTop: 12,
            borderTop: "1px solid var(--vs-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {replies.map((reply) => (
            <div key={reply.id}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  marginBottom: 3,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--vs-mono)",
                    fontWeight: 700,
                    fontSize: 13.5,
                    color:
                      reply.author === "danny"
                        ? "var(--vs-accent)"
                        : "var(--vs-amber)",
                  }}
                >
                  @{reply.author_handle}
                </span>
                {reply.author === "danny" && (
                  <span style={{ ...PILL, color: "var(--vs-muted)" }}>staff</span>
                )}
                <span
                  style={{
                    marginLeft: "auto",
                    color: "var(--vs-muted)",
                    fontSize: 12,
                  }}
                >
                  {formatWhen(reply.created_at)}
                </span>
              </div>
              <p
                style={{
                  margin: 0,
                  lineHeight: 1.6,
                  fontSize: 14,
                  overflowWrap: "anywhere",
                  whiteSpace: "pre-wrap",
                }}
              >
                {reply.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
