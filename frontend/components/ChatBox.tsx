"use client";

/**
 * ChatBox — the native per-page chat room.
 *
 * Anyone can chat with a chosen username (no wallet required); the page
 * owner and promoted mods filter. Polls the room endpoint every few seconds.
 * Chatting with a connected wallet marks messages verified with the
 * author's address — mods act on that address, so mod powers can't be
 * spoofed by picking someone's username.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionOptional } from "@/lib/session";
import { SESSION_HEADER } from "@/lib/session-message";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { I18nKey } from "@/lib/i18n/dictionaries";

interface ChatMsg {
  id: number;
  name: string;
  body: string;
  ts: number;
  wallet: string | null;
}

interface ModState {
  mods: string[];
  mutes: { target: string; expiresAtMs: number }[];
  bans: { target: string }[];
  filters: string[];
}

type Role = "owner" | "mod" | "viewer";

const POLL_MS = 3500;
const NAME_KEY = "pagechat:name";

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatBox({
  room,
  title,
  preview,
}: {
  room: string;
  title?: string;
  preview?: boolean;
}) {
  const { t } = useLanguage();
  // The Buddy chat widget mounts outside SessionProvider: degrade to
  // logged-out instead of throwing (the preview branch below renders an
  // inert placeholder and never touches the token anyway).
  const session = useSessionOptional();
  const token = session?.token ?? null;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [since, setSince] = useState(0);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("viewer");
  const [modState, setModState] = useState<ModState>({ mods: [], mutes: [], bans: [], filters: [] });
  const [toolsOpen, setToolsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [filterWord, setFilterWord] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef(0);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(NAME_KEY);
      if (saved) setName(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const authHeader = useCallback((): Record<string, string> => {
    const tok = token?.() ?? null;
    return tok ? { [SESSION_HEADER]: tok } : {};
  }, [token, session]);

  const applyMessages = useCallback((incoming: ChatMsg[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return prev;
      const merged = [...prev, ...fresh].sort((a, b) => a.id - b.id).slice(-100);
      // Auto-scroll only when already near the bottom.
      const el = listRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 140) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
      return merged;
    });
    const maxId = Math.max(...incoming.map((m) => m.id));
    setSince(maxId);
    sinceRef.current = maxId;
  }, []);

  const poll = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    try {
      const res = await fetch(`/api/pagechat/${encodeURIComponent(room)}?since=${sinceRef.current}`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: ChatMsg[] };
      applyMessages(data.messages ?? []);
    } catch {
      /* transient — next poll retries */
    }
  }, [room, applyMessages]);

  useEffect(() => {
    if (preview) return;
    sinceRef.current = 0;
    setMessages([]);
    setSince(0);
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [room, preview, poll]);

  // Who am I in this room? (owner/mod get the mod panel state)
  useEffect(() => {
    if (preview) return;
    const tok = token?.() ?? null;
    if (!tok) {
      setRole("viewer");
      return;
    }
    let cancelled = false;
    fetch(`/api/pagechat/${encodeURIComponent(room)}/role`, {
      headers: { [SESSION_HEADER]: tok },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setRole(d.role ?? "viewer");
        if (d.role === "owner" || d.role === "mod") {
          setModState({
            mods: d.mods ?? [],
            mutes: d.mutes ?? [],
            bans: d.bans ?? [],
            filters: d.filters ?? [],
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [room, preview, token, session]);

  const send = useCallback(async () => {
    const cleanName = name.trim().slice(0, 24);
    const text = body.trim();
    if (!cleanName) {
      setError(t("pagechat.needName"));
      return;
    }
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      window.localStorage.setItem(NAME_KEY, cleanName);
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`/api/pagechat/${encodeURIComponent(room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ name: cleanName, body: text }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: ChatMsg };
      if (!res.ok) {
        setError(data.error || t("pagechat.failed"));
        return;
      }
      setBody("");
      if (data.message) applyMessages([data.message]);
    } catch {
      setError(t("pagechat.failed"));
    } finally {
      setSending(false);
    }
  }, [name, body, sending, room, authHeader, applyMessages, t]);

  const moderate = useCallback(
    async (payload: Record<string, unknown>) => {
      setMenuFor(null);
      try {
        const res = await fetch(`/api/pagechat/${encodeURIComponent(room)}/moderate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader() },
          body: JSON.stringify(payload),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<ModState> & { error?: string };
        if (!res.ok) {
          setError(data.error || t("pagechat.failed"));
          return;
        }
        setModState({
          mods: data.mods ?? [],
          mutes: data.mutes ?? [],
          bans: data.bans ?? [],
          filters: data.filters ?? [],
        });
        if (payload.action === "delete" && typeof payload.messageId === "number") {
          const id = payload.messageId;
          setMessages((prev) => prev.filter((m) => m.id !== id));
        } else {
          // Mute/ban/filter changes: refresh the visible list.
          poll();
        }
      } catch {
        setError(t("pagechat.failed"));
      }
    },
    [room, authHeader, poll, t],
  );

  if (preview) {
    return (
      <section className="pv-block" aria-label={t("pagechat.title")}>
        <h2 className="pv-block-title">{title || t("pagechat.title")}</h2>
        <p className="vs-muted">{t("pagechat.previewNote")}</p>
      </section>
    );
  }

  const canMod = role === "owner" || role === "mod";
  const walletConnected = !!token?.();

  return (
    <section className="pv-block vs-chatbox" aria-label={title || t("pagechat.title")}>
      <h2 className="pv-block-title">
        {title || t("pagechat.title")}
        {canMod && (
          <button
            type="button"
            className="vs-btn vs-btn-ghost vs-chatbox-toolsbtn"
            onClick={() => setToolsOpen((v) => !v)}
            aria-expanded={toolsOpen}
          >
            {t("pagechat.modTools")}
          </button>
        )}
      </h2>

      {toolsOpen && canMod && (
        <div className="vs-chatbox-tools">
          <div className="vs-chatbox-toolsrow">
            <strong>{t("pagechat.mods")}</strong>
            {modState.mods.length === 0 && <span className="vs-muted">—</span>}
            {modState.mods.map((m) => (
              <span key={m} className="vs-chatbox-chip">
                {shortAddr(m)}
                {role === "owner" && (
                  <button
                    type="button"
                    aria-label={t("pagechat.removeMod")}
                    onClick={() => moderate({ action: "demote", target: m })}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="vs-chatbox-toolsrow">
            <strong>{t("pagechat.filters")}</strong>
            <span className="vs-chatbox-addrow">
              <input
                className="vs-input"
                value={filterWord}
                onChange={(e) => setFilterWord(e.target.value)}
                placeholder={t("pagechat.wordPh")}
                maxLength={24}
                aria-label={t("pagechat.filters")}
              />
              <button
                type="button"
                className="vs-btn vs-btn-ghost"
                onClick={() => {
                  if (filterWord.trim()) moderate({ action: "filter-add", word: filterWord.trim() });
                  setFilterWord("");
                }}
              >
                {t("pagechat.add")}
              </button>
            </span>
            {modState.filters.map((w) => (
              <span key={w} className="vs-chatbox-chip">
                {w}
                <button
                  type="button"
                  aria-label={t("pagechat.removeMod")}
                  onClick={() => moderate({ action: "filter-remove", word: w })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {(modState.mutes.length > 0 || modState.bans.length > 0) && (
            <div className="vs-chatbox-toolsrow">
              <strong>{t("pagechat.restrictions")}</strong>
              {modState.mutes.map((m) => (
                <span key={m.target} className="vs-chatbox-chip">
                  {m.target}
                  <button
                    type="button"
                    aria-label={t("pagechat.lift")}
                    onClick={() => moderate({ action: "unmute", target: m.target })}
                  >
                    {t("pagechat.lift")}
                  </button>
                </span>
              ))}
              {modState.bans.map((b) => (
                <span key={b.target} className="vs-chatbox-chip vs-chatbox-chip-ban">
                  {b.target}
                  <button
                    type="button"
                    aria-label={t("pagechat.lift")}
                    onClick={() => moderate({ action: "unban", target: b.target })}
                  >
                    {t("pagechat.lift")}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div ref={listRef} className="vs-chatbox-list" role="log" aria-live="polite">
        {messages.length === 0 && <p className="vs-muted">{t("pagechat.empty")}</p>}
        {messages.map((m) => (
          <div key={m.id} className="vs-chatbox-msg">
            <div className="vs-chatbox-msghead">
              <span className="vs-chatbox-name">
                {m.name}
                {m.wallet && (
                  <span className="vs-chatbox-verified" title={m.wallet}>
                    ✓
                  </span>
                )}
              </span>
              <span className="vs-chatbox-time">{fmtTime(m.ts)}</span>
              {canMod && (
                <button
                  type="button"
                  className="vs-chatbox-menubtn"
                  aria-label={t("pagechat.modTools")}
                  onClick={() => setMenuFor(menuFor === m.id ? null : m.id)}
                >
                  ⋯
                </button>
              )}
            </div>
            <p className="vs-chatbox-body">{m.body}</p>
            {canMod && menuFor === m.id && (
              <div className="vs-chatbox-actions">
                <button type="button" onClick={() => moderate({ action: "delete", messageId: m.id })}>
                  {t("pagechat.delete")}
                </button>
                <button type="button" onClick={() => moderate({ action: "mute", messageId: m.id })}>
                  {t("pagechat.mute")}
                </button>
                <button type="button" onClick={() => moderate({ action: "ban", messageId: m.id })}>
                  {t("pagechat.ban")}
                </button>
                {role === "owner" && m.wallet && (
                  <button
                    type="button"
                    onClick={() => moderate({ action: "promote", target: m.wallet })}
                  >
                    {t("pagechat.makeMod")}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {error && (
        <p className="vs-chatbox-error" role="alert">
          {error}
        </p>
      )}

      <div className="vs-chatbox-composer">
        <input
          className="vs-input vs-chatbox-nameinput"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("pagechat.namePh")}
          maxLength={24}
          aria-label={t("pagechat.namePh")}
        />
        <input
          className="vs-input vs-chatbox-textinput"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("pagechat.messagePh")}
          maxLength={500}
          aria-label={t("pagechat.messagePh")}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          type="button"
          className="vs-btn vs-btn-primary"
          onClick={send}
          disabled={sending || !body.trim()}
        >
          {t("pagechat.send")}
        </button>
      </div>
      {!walletConnected && <p className="vs-muted vs-chatbox-hint">{t("pagechat.verifyHint")}</p>}
    </section>
  );
}

/** Stable i18n key list for tests/docs. */
export const PAGECHAT_I18N_KEYS = [
  "pagechat.title",
  "pagechat.messagePh",
  "pagechat.send",
  "pagechat.namePh",
  "pagechat.empty",
  "pagechat.verifyHint",
  "pagechat.delete",
  "pagechat.mute",
  "pagechat.ban",
  "pagechat.makeMod",
  "pagechat.mods",
  "pagechat.removeMod",
  "pagechat.filters",
  "pagechat.wordPh",
  "pagechat.add",
  "pagechat.restrictions",
  "pagechat.lift",
  "pagechat.modTools",
  "pagechat.failed",
  "pagechat.needName",
  "pagechat.previewNote",
] as const satisfies readonly I18nKey[];
