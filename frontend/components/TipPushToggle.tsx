"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { useSession } from "@/lib/session";
import {
  PUSH_VAPID_PUBLIC_KEY,
  pushToggleStorageKey,
  urlBase64ToUint8Array,
} from "@/lib/push";

type ToggleState = "loading" | "on" | "off" | "denied" | "unsupported";

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * Owner-only "Tip notifications" switch for blockpages.
 *
 * Enable flow: Notification.requestPermission() → register /sw.js →
 * pushManager.subscribe() → POST /api/push/subscriptions (x-vs-session).
 * Disable flow: pushManager.unsubscribe() → DELETE /api/push/subscriptions.
 * Toggle state persists per wallet in localStorage; the live push
 * subscription is always the source of truth.
 */
export function TipPushToggle({ wallet }: { wallet: string }) {
  const { t, lang } = useLanguage();
  const { authHeader } = useSession();
  const [state, setState] = useState<ToggleState>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const storageKey = pushToggleStorageKey(wallet);

  // Initial state: live subscription wins over the persisted flag.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) {
        if (!cancelled) setState("unsupported");
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setState("denied");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setState(sub ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (!pushSupported()) {
        setState("unsupported");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        setMessage(t("push.denied"));
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUSH_VAPID_PUBLIC_KEY),
      });
      const json = sub.toJSON();
      const keys = json.keys ?? {};
      const res = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader() },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" },
          lang,
        }),
      });
      if (!res.ok) {
        // Server rejected it — don't leave a dangling browser subscription.
        await sub.unsubscribe().catch(() => {});
        throw new Error(`server responded ${res.status}`);
      }
      try {
        localStorage.setItem(storageKey, "1");
      } catch {
        /* storage unavailable — the live subscription is the source of truth */
      }
      setState("on");
    } catch {
      setMessage(t("push.error"));
      setState("off");
    } finally {
      setBusy(false);
    }
  }, [authHeader, lang, storageKey, t]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      let endpoint = "";
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          endpoint = sub.endpoint;
          await sub.unsubscribe();
        }
      } catch {
        /* no subscription to remove — still tell the server */
      }
      if (endpoint) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "content-type": "application/json", ...authHeader() },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {
          /* best effort — the browser subscription is already gone */
        });
      }
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
      setState("off");
    } catch {
      setMessage(t("push.error"));
    } finally {
      setBusy(false);
    }
  }, [authHeader, storageKey, t]);

  const onToggle = useCallback(() => {
    if (busy || state === "loading" || state === "unsupported" || state === "denied") return;
    if (state === "on") void disable();
    else void enable();
  }, [busy, state, disable, enable]);

  const isOn = state === "on";

  return (
    <div
      style={{
        border: "1px solid rgba(16,185,129,0.25)",
        borderRadius: 12,
        padding: "12px 14px",
        marginTop: 12,
        background: "rgba(16,185,129,0.06)",
      }}
      aria-live="polite"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-label={t("push.title")}
          onClick={onToggle}
          disabled={busy || state === "loading" || state === "unsupported"}
          style={{
            flexShrink: 0,
            width: 44,
            height: 24,
            borderRadius: 999,
            border: "none",
            cursor: busy ? "wait" : "pointer",
            background: isOn ? "#10b981" : "rgba(255,255,255,0.18)",
            position: "relative",
            transition: "background 0.15s ease",
            opacity: state === "unsupported" ? 0.5 : 1,
            padding: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 3,
              left: isOn ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.15s ease",
            }}
          />
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{t("push.title")}</div>
          <div style={{ fontSize: "0.82rem", opacity: 0.75, marginTop: 2 }}>
            {state === "loading"
              ? "…"
              : state === "unsupported"
                ? t("push.unsupported")
                : isOn
                  ? busy
                    ? t("push.disabling")
                    : t("push.on")
                  : busy
                    ? t("push.enabling")
                    : t("push.desc")}
          </div>
        </div>
      </div>
      {message && (
        <div style={{ fontSize: "0.82rem", marginTop: 8, opacity: 0.9 }}>{message}</div>
      )}
    </div>
  );
}
