"use client";

/**
 * Livestream block (Phase 1): Twitch/YouTube embeds only — $0, no video
 * pipeline. The blockpage is never in the video pipeline; the owner streams
 * to the platform directly (OBS/phone app) and this block embeds the
 * platform's own player.
 *
 * Honesty rules:
 * - Offline is the default. Twitch shows the player only after the player
 *   fires ONLINE; YouTube only after the server status check says live.
 * - Never show a raw platform error state — an offline card always stands in.
 * - Chat is the official platform embed (Twitch chat, or YouTube live_chat
 *   for the currently-playing video) — never faked. On phones it is a
 *   floating, draggable widget so viewers watch and chat at the same time;
 *   desktop keeps it side-by-side with the player.
 * - Tips reuse the page's existing onTip flow (atomic 98/2 contract).
 *   No new money code here.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { sanitizeLivestreamChannel, type Block } from "@/lib/schema";
import type { I18nKey } from "@/lib/i18n/dictionaries";
import { IconPlay, IconTip } from "./icons";

type LivestreamBlockT = Extract<Block, { type: "livestream" }>;

declare global {
  interface Window {
    Twitch?: any;
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const TWITCH_SCRIPT = "https://player.twitch.tv/js/embed/v1.js";
const YOUTUBE_API_SCRIPT = "https://www.youtube.com/iframe_api";

/** Placeholder so the player hooks run unconditionally (hooks rule) when the
 *  channel is invalid; the effects bail out early and the component renders
 *  the invalid-channel path instead. */
const PLACEHOLDER_CHANNEL = "___invalid___";

let twitchScriptPromise: Promise<void> | null = null;
function loadTwitchScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Twitch?.Player) return Promise.resolve();
  if (!twitchScriptPromise) {
    twitchScriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TWITCH_SCRIPT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        twitchScriptPromise = null;
        reject(new Error("twitch embed script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return twitchScriptPromise;
}

let youTubeApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.YT?.Player) return Promise.resolve();
  if (!youTubeApiPromise) {
    youTubeApiPromise = new Promise<void>((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const s = document.createElement("script");
      s.src = YOUTUBE_API_SCRIPT;
      s.async = true;
      s.onerror = () => {
        youTubeApiPromise = null;
        reject(new Error("youtube iframe api failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return youTubeApiPromise;
}

/** Twitch interactive player. `live` flips true only on the player's ONLINE event. */
function useTwitchPlayer(channel: string) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLive(false);
    if (channel === PLACEHOLDER_CHANNEL) return () => {};
    loadTwitchScript()
      .then(() => {
        if (cancelled || !mountRef.current) return;
        const p = new window.Twitch.Player(mountRef.current, {
          channel,
          // Twitch requires the embedding host (no scheme) or the player refuses to load.
          parent: [window.location.hostname],
          muted: true,
          autoplay: true,
          width: "100%",
          height: "100%",
        });
        playerRef.current = p;
        p.addEventListener(window.Twitch.Player.READY, () => {
          p.addEventListener(window.Twitch.Player.ONLINE, () => {
            if (!cancelled) setLive(true);
          });
          p.addEventListener(window.Twitch.Player.OFFLINE, () => {
            if (!cancelled) setLive(false);
          });
        });
      })
      .catch(() => {
        // Script failed: stay offline. Never surface a raw player error.
        if (!cancelled) setLive(false);
      });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore teardown errors */
      }
      playerRef.current = null;
    };
  }, [channel]);

  const unmute = () => {
    try {
      playerRef.current?.setMuted(false);
    } catch {
      /* ignore */
    }
  };

  return { mountRef, live, unmute };
}

/**
 * YouTube live player via the undocumented live_stream?channel= embed plus
 * the official IFrame Player API for state inference. `live` flips true only
 * when the player reports PLAYING; onError 100/150 (unavailable / embedding
 * not allowed) confirms offline. Never trust the iframe's own error card.
 */
/**
 * YouTube live status via our own /api/youtube-live — the server checks the
 * channel's public /live page (canonical link -> watch?v=... when live).
 * Re-checked every 5 minutes so a stream ending flips the block back to
 * offline honestly. The IFrame API is only attached to the direct video
 * embed for tap-to-unmute — never for live detection, because watching the
 * live_stream?channel= resolver embed for a PLAYING event proved unreliable
 * (the badge stayed offline on real phones even with a live stream).
 * Offline-first: any check failure keeps the current state, default offline.
 */
function useYouTubeLive(channelId: string) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const playerRef = useRef<any>(null);
  const [status, setStatus] = useState<{ live: boolean; videoId: string | null }>({
    live: false,
    videoId: null,
  });

  useEffect(() => {
    let cancelled = false;
    setStatus({ live: false, videoId: null });
    if (channelId === PLACEHOLDER_CHANNEL) return () => {};
    const check = async () => {
      try {
        const r = await fetch(`/api/youtube-live?channel=${encodeURIComponent(channelId)}`, {
          cache: "no-store",
        });
        const j = await r.json();
        const videoId = typeof j?.videoId === "string" && j.videoId.length === 11 ? j.videoId : null;
        if (!cancelled && j?.ok) setStatus({ live: j.live === true && !!videoId, videoId });
      } catch {
        /* offline-first: keep current status */
      }
    };
    check();
    const timer = setInterval(check, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [channelId]);

  // Tap-to-unmute bridge on the direct video embed (best effort only).
  useEffect(() => {
    let cancelled = false;
    playerRef.current = null;
    if (!status.live || !status.videoId) return () => {};
    loadYouTubeApi()
      .then(() => {
        if (cancelled || !iframeRef.current || !window.YT?.Player) return;
        playerRef.current = new window.YT.Player(iframeRef.current, {});
      })
      .catch(() => {
        /* unmute stays unavailable; video still plays muted */
      });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* ignore teardown errors */
      }
      playerRef.current = null;
    };
  }, [status.live, status.videoId]);

  const unmute = () => {
    try {
      playerRef.current?.unMute?.();
      playerRef.current?.setVolume?.(100);
    } catch {
      /* ignore */
    }
  };

  return { iframeRef, live: status.live, unmute, videoId: status.videoId };
}

/**
 * Official YouTube live-chat embed for the currently-playing video.
 * embed_domain must match the embedding host or YouTube refuses to load it.
 */
export function youTubeLiveChatSrc(videoId: string, hostname: string): string {
  return (
    `https://www.youtube.com/live_chat?v=${encodeURIComponent(videoId)}` +
    `&embed_domain=${encodeURIComponent(hostname)}`
  );
}

/**
 * Media-query hook so exactly one chat iframe exists at a time: the floating
 * widget on phones, the inline column on desktop. Defaults from
 * window.innerWidth so the first paint already matches the device.
 */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 640,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Floating chat widget (phones): starts as a small bubble so it never covers
 * the video on load. Tapping it opens a panel that drags by its header and
 * collapses back to the bubble with the X. The chat iframe mounts on first
 * open and stays mounted while collapsed (slid off-screen) so the live
 * conversation doesn't reload every time it's tucked away.
 */
function FloatingChatWidget({ chatSrc, t }: { chatSrc: string; t: (k: I18nKey) => string }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; dx: number; dy: number } | null>(null);

  const openPanel = () => {
    setMounted(true);
    setOpen(true);
  };

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Let the close button receive its own tap — never start a drag from it.
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
  };

  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const panel = panelRef.current;
    if (!panel || typeof window === "undefined") return;
    const w = panel.offsetWidth;
    const x = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8));
    // Keep the header reachable: never drag the panel fully off the top.
    const y = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - 96));
    setPos({ x, y });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current && dragRef.current.pointerId === e.pointerId) dragRef.current = null;
  };

  return (
    <div className="vs-chatfloat-root">
      {!open && (
        <button
          type="button"
          className="vs-chatfloat-bubble"
          onClick={openPanel}
          aria-label={t("livestream.chat")}
        >
          <span aria-hidden="true">💬</span>
        </button>
      )}
      {mounted && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("livestream.chat")}
          className={`vs-chatfloat-panel${open ? "" : " vs-chatfloat-collapsed"}`}
          style={
            pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined
          }
        >
          <div
            className="vs-chatfloat-header"
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span>
              <span aria-hidden="true">💬 </span>
              {t("livestream.chat")}
            </span>
            <button
              type="button"
              className="vs-chatfloat-close"
              onClick={() => setOpen(false)}
              aria-label={t("livestream.chat")}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <div className="vs-chatfloat-body">
            <iframe
              src={chatSrc}
              title={t("livestream.chat")}
              className="vs-chatfloat-frame"
              allowFullScreen
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default function LivestreamBlock({
  block,
  tipInteractive,
  onTip,
  preview,
}: {
  block: LivestreamBlockT;
  tipInteractive?: boolean;
  onTip?: () => void;
  /** Builder preview: shows a quiet note when the channel can't be embedded. */
  preview?: boolean;
}) {
  const { t } = useLanguage();
  const [unmuted, setUnmuted] = useState(false);
  // One chat iframe at a time: floating widget on phones, inline column on desktop.
  const isMobile = useMatchMedia("(max-width: 640px)");

  const channel = sanitizeLivestreamChannel(block.platform, block.channel);

  // Hooks must run unconditionally — use a safe placeholder and gate rendering.
  const twitch = useTwitchPlayer(channel && block.platform === "twitch" ? channel : PLACEHOLDER_CHANNEL);
  const youTube = useYouTubeLive(channel && block.platform === "youtube" ? channel : PLACEHOLDER_CHANNEL);

  if (!channel) {
    // Bad config: render nothing on a live page; a quiet note in the builder
    // preview only, so the owner knows what to fix.
    if (!preview) return null;
    return (
      <section className="pv-block" aria-label={t("livestream.title")}>
        <p className="pv-empty">{t("livestream.invalidChannel")}</p>
      </section>
    );
  }

  const isTwitch = block.platform === "twitch";
  const { live, unmute } = isTwitch ? twitch : youTube;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const twitchChatSrc = `https://www.twitch.tv/embed/${channel}/chat?parent=${encodeURIComponent(hostname)}&darkpopout`;
  // YouTube chat exists only while a concrete live video is playing.
  const youTubeChat =
    !isTwitch && live && youTube.videoId ? youTubeLiveChatSrc(youTube.videoId, hostname) : null;
  const activeChatSrc = isTwitch ? twitchChatSrc : youTubeChat;
  const youTubeSrc =
    live && youTube.videoId
      ? // Live: embed the concrete video directly — the well-trodden path.
        // (The live_stream?channel= resolver embed is only a placeholder
        // while offline; its PLAYING event proved unreliable for detection.)
        `https://www.youtube.com/embed/${youTube.videoId}` +
        `?autoplay=1&mute=1&playsinline=1&enablejsapi=1&rel=0` +
        (typeof window !== "undefined" ? `&origin=${encodeURIComponent(window.location.origin)}` : "")
      : `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channel)}` +
        `&autoplay=1&mute=1&playsinline=1&enablejsapi=1` +
        (typeof window !== "undefined" ? `&origin=${encodeURIComponent(window.location.origin)}` : "");
  const followUrl = isTwitch
    ? `https://www.twitch.tv/${channel}`
    : `https://www.youtube.com/channel/${channel}`;

  const handleUnmute = () => {
    unmute();
    setUnmuted(true);
  };

  const title = block.title?.trim() || t("livestream.title");

  return (
    <section className="pv-block vs-livestream" aria-label={title}>
      <h2 className="pv-block-title">
        <IconPlay size={20} />
        <span>{title}</span>
        {live && (
          <span className="vs-live-badge" aria-live="polite">
            <span className="vs-live-dot" aria-hidden="true" />
            {t("livestream.live")}
          </span>
        )}
      </h2>

      <div className="vs-livestream-layout">
        <div className="vs-livestream-player">
          {isTwitch ? (
            <div className="vs-livestream-embedwrap">
              {/* The player mounts underneath; it appears only on the ONLINE event. */}
              <div ref={twitch.mountRef} className="vs-livestream-frame" />
              {!live && (
                <div className="vs-livestream-overlay">
                  <OfflineCard followUrl={followUrl} t={t} />
                </div>
              )}
            </div>
          ) : (
            <div className="vs-livestream-embedwrap">
              {/* Live state comes from /api/youtube-live (server checks the
                  channel's /live page). The iframe embeds the concrete live
                  video directly; the IFrame API is attached for tap-to-unmute
                  only. The offline overlay covers the iframe until the server
                  says live — the raw iframe is never shown while offline. */}
              <iframe
                ref={youTube.iframeRef}
                className="vs-livestream-frame"
                src={youTubeSrc}
                title={title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
              {!live && (
                <div className="vs-livestream-overlay">
                  <OfflineCard followUrl={followUrl} t={t} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Desktop keeps chat side-by-side; phones get the floating widget
            below so viewers watch and chat at the same time. */}
        {activeChatSrc && !isMobile && (
          <div className="vs-livestream-chat">
            <iframe
              src={activeChatSrc}
              title={t("livestream.chat")}
              className="vs-livestream-frame"
              allowFullScreen
            />
          </div>
        )}
      </div>

      {activeChatSrc && isMobile && <FloatingChatWidget chatSrc={activeChatSrc} t={t} />}

      <div className="vs-livestream-actions">
        {live && !unmuted && (
          <button type="button" className="vs-btn vs-btn-ghost" onClick={handleUnmute}>
            🔊 {t("livestream.tapForSound")}
          </button>
        )}
        {tipInteractive && onTip && (
          <button type="button" className="vs-btn vs-btn-primary" onClick={onTip}>
            <IconTip size={16} /> {t("livestream.tipStreamer")}
          </button>
        )}
        <a
          className="vs-livestream-follow"
          href={followUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("livestream.follow")} ↗
        </a>
      </div>
    </section>
  );
}

function OfflineCard({ followUrl, t }: { followUrl: string; t: (k: I18nKey) => string }) {
  return (
    <div className="vs-livestream-offline" role="status">
      <div className="vs-livestream-offline-icon" aria-hidden="true">
        📺
      </div>
      <p className="vs-livestream-offline-text">{t("livestream.offline")}</p>
      <a
        className="vs-livestream-follow"
        href={followUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("livestream.follow")} ↗
      </a>
    </div>
  );
}
