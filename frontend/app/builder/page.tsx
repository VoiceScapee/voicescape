"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import PageRenderer from "@/components/PageRenderer";
import Logo from "@/components/Logo";
import { VoiceInput } from "@/components/VoiceInput";
import { consumeOnboardDraft, consumeBuddyDraft, consumeBuddyPublishIntent, ONBOARD_DRAFT_KEY } from "@/components/Onboarding";
import { markPublished } from "@/components/OnboardingTrigger";
import { stashClaimCongrats } from "@/lib/claim-congrats";
import {
  IconArrowRight,
  IconBolt,
  IconBook,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconExternal,
  IconGlobe,
  IconGrid,
  IconLink,
  IconMusic,
  IconPlus,
  IconSpark,
  IconTip,
  IconTrash,
  IconUsers,
  PlatformIcon,
} from "@/components/icons";
import {
  PICKER_BLOCK_TYPES,
  PICKER_LABELS,
  createDefaultBlock,
  isValidPage,
  type Block,
  type BlockType,
  type MusicTrack,
  type ProfileSongRef,
  type VoicescapePage,
} from "@/lib/schema";
import { MUSIC_SOURCE_LABELS, parseMusicUrl } from "@/lib/music";
import {
  PLATFORMS,
  detectPlatform,
  isPlatformId,
  normalizeSocialUrl,
} from "@/lib/socials";
import { pinAudioFile } from "@/lib/ipfs";
import {
  applyOnboardSocials,
  buildDesignFromLinksInstruction,
  socialsUrls,
} from "@/lib/quickbuild";
import { TEMPLATES, isTemplateVisible, type Template } from "@/lib/templates";
import { friendlyWalletError, getHederaPairing, isStaleConnectionError, repairStaleConnection, requestWalletConnectUI, useWallet, WALLET_ADAPTERS } from "@/lib/wallet";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { sanitizeDraftName, draftFileUrl } from "@/lib/drafts";
import { WalletConnect } from "@/components/WalletConnect";
import { useSession, SignInButton } from "@/lib/session";
import { useHcsSubmit } from "@/components/townhall/useHcsSubmit";
import {
  BYOK_CONSOLE_URL,
  ByokError,
  clearByokKey,
  DEFAULT_BYOK_MODEL,
  generatePageWithByokKey,
  getByokKey,
  hasByokKey,
  setByokKey,
} from "@/lib/byok";
import { getActiveChain } from "@/lib/chains";
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { recordConversionEvent } from "@/lib/metrics";
import { recordUsageEvent } from "@/lib/usage";
import { reportError } from "@/lib/report-error";
import { registerPage, updatePage, ZERO_ADDRESS, getRegistryAddress } from "@/lib/contracts";
import {
  deriveUsername,
  deriveUsernameFromEvm,
  fetchRegisteredUsername,
  getVanityName,
  isValidUsername,
  setVanityName,
} from "@/lib/identity";
import { fetchPageJson, pinPageJson } from "@/lib/ipfs";
import { postJson } from "@/lib/townhall";
import {
  createWalletHederaSigner,
  formatUsdCents,
  getX402VibecodeUrl,
  payX402,
  probeX402,
  type X402Rail,
} from "@/lib/x402";
import { AccountId } from "@hiero-ledger/sdk";
import { summarizeChanges, type AiDraft } from "./vibecode-utils";
import "./builder.css";

/* ---------------------------------------------------------------- */
/* Helpers                                                          */
/* ---------------------------------------------------------------- */

/**
 * B5 (flow audit 2026-10-02): local autosave for the builder canvas.
 * A phone tab killed mid-design used to vaporize all work. The canvas now
 * autosaves (debounced) to localStorage, restores on mount, and clears on
 * successful publish. Local-only — never leaves the browser, never
 * auto-publishes.
 */
const BUILDER_AUTOSAVE_KEY = "vs_builder_autosave";

interface BuilderAutosave {
  v: 1;
  savedAt: number;
  templateId: string;
  username: string;
  page: VoicescapePage;
}

function readBuilderAutosave(): BuilderAutosave | null {
  try {
    const raw = localStorage.getItem(BUILDER_AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuilderAutosave>;
    if (parsed?.v !== 1 || typeof parsed.savedAt !== "number") return null;
    if (typeof parsed.templateId !== "string" || !TEMPLATES.some((t) => t.id === parsed.templateId))
      return null;
    if (typeof parsed.username !== "string") return null;
    if (!isValidPage(parsed.page)) return null;
    return parsed as BuilderAutosave;
  } catch {
    return null;
  }
}

/** Clear the autosave — called on successful publish. Never throws. */
function clearBuilderAutosave(): void {
  try {
    localStorage.removeItem(BUILDER_AUTOSAVE_KEY);
  } catch {
    /* ignore */
  }
}

function setBlock(blocks: Block[], index: number, next: Block): Block[] {
  const copy = [...blocks];
  copy[index] = next;
  return copy;
}

function truncMiddle(v: string, head = 6, tail = 4): string {
  return v.length > head + tail + 3 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v;
}

const shortFont = (f: string) => f.split(",")[0];

function BlockTypeIcon({ type, size = 16 }: { type: BlockType; size?: number }) {
  switch (type) {
    case "hero":
      return <IconSpark size={size} />;
    case "bio":
      return <IconBook size={size} />;
    case "links":
      return <IconLink size={size} />;
    case "socials":
      return <IconGlobe size={size} />;
    case "music":
      return <IconMusic size={size} />;
    case "gallery":
      return <IconGrid size={size} />;
    case "guestbook":
      return <IconUsers size={size} />;
    case "tipJar":
      return <IconTip size={size} />;
    case "services":
      return <IconBolt size={size} />;
    case "capabilities":
      return <IconSpark size={size} />;
    case "operator":
      return <IconUsers size={size} />;
    case "reviews":
      return <IconBook size={size} />;
    case "booking":
      return <IconLink size={size} />;
    case "heartbeat":
      return <IconBolt size={size} />;
    case "tabs":
      return <IconGrid size={size} />;
    case "badges":
      return <IconSpark size={size} />;
    case "nftGallery":
      return <IconGrid size={size} />;
  }
}

/* ---------------------------------------------------------------- */
/* Per-block field editors                                           */
/* ---------------------------------------------------------------- */

/**
 * Editor for the music block: paste platform links (auto-detected), upload
 * your own audio to IPFS, reorder/remove tracks, and mark one track as the
 * Featured profile song (stored page-level).
 */
function MusicTrackEditor({
  block,
  blockIndex,
  onChange,
  profileSong,
  onProfileSongChange,
}: {
  block: Extract<Block, { type: "music" }>;
  blockIndex: number;
  onChange: (next: Block) => void;
  profileSong?: ProfileSongRef;
  onProfileSongChange: (ref: ProfileSongRef | undefined) => void;
}) {
  const tracks: MusicTrack[] = Array.isArray(block.tracks) ? block.tracks : [];
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const addTrack = (t: MusicTrack) =>
    onChange({ ...block, tracks: [...tracks, t] });

  const addLink = () => {
    const parsed = parseMusicUrl(linkInput);
    if (!parsed) {
      setLinkError("Couldn't detect a Spotify, YouTube, or SoundCloud track in that link.");
      return;
    }
    setLinkError(null);
    setLinkInput("");
    addTrack(parsed);
  };

  const moveTrack = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= tracks.length) return;
    const next = [...tracks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ ...block, tracks: next });
    // Keep the profile-song ref pointing at the same track after reordering.
    if (profileSong && profileSong.blockIndex === blockIndex) {
      if (profileSong.trackIndex === i)
        onProfileSongChange({ blockIndex, trackIndex: j });
      else if (profileSong.trackIndex === j)
        onProfileSongChange({ blockIndex, trackIndex: i });
    }
  };

  const removeTrack = (i: number) => {
    onChange({ ...block, tracks: tracks.filter((_, k) => k !== i) });
    if (profileSong && profileSong.blockIndex === blockIndex) {
      if (profileSong.trackIndex === i) onProfileSongChange(undefined);
      else if (profileSong.trackIndex > i)
        onProfileSongChange({ blockIndex, trackIndex: profileSong.trackIndex - 1 });
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const cid = await pinAudioFile(file);
      const base = file.name.replace(/\.[^.]+$/, "");
      addTrack({ source: "ipfs", id: cid, title: base || "My track" });
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const isProfile = (i: number) =>
    profileSong?.blockIndex === blockIndex && profileSong.trackIndex === i;

  return (
    <>
      <div className="vb-row" style={{ gap: 8 }}>
        <input
          className="vs-input"
          style={{ flex: 1 }}
          value={linkInput}
          placeholder="Paste a Spotify, YouTube, or SoundCloud link"
          onChange={(e) => setLinkInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addLink();
            }
          }}
          aria-label="Paste a music link"
        />
        <button type="button" className="vs-btn vs-btn-ghost" onClick={addLink}>
          <IconPlus size={16} /> Add track
        </button>
      </div>
      {linkError && <p className="vb-error">{linkError}</p>}

      <div className="vb-row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
        <label className="vs-btn vs-btn-ghost" style={{ cursor: "pointer" }}>
          <IconMusic size={16} /> {uploading ? "Uploading…" : "Upload your own music"}
          <input
            type="file"
            accept="audio/*"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadFile(f);
            }}
          />
        </label>
        <span className="vs-hint">MP3, WAV, OGG… up to 25 MB, pinned to IPFS</span>
      </div>
      {uploadError && <p className="vb-error">{uploadError}</p>}

      {tracks.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          {tracks.map((t, i) => (
            <div key={`${t.source}-${t.id}-${i}`} className="vb-row" style={{ gap: 8, alignItems: "center" }}>
              <span className="vs-chip" title={t.id}>
                {MUSIC_SOURCE_LABELS[t.source]}
              </span>
              <input
                className="vs-input"
                style={{ flex: 1, minWidth: 0 }}
                value={t.title ?? ""}
                placeholder="Title"
                aria-label={`Track ${i + 1} title`}
                onChange={(e) => {
                  const next = [...tracks];
                  next[i] = { ...next[i], title: e.target.value };
                  onChange({ ...block, tracks: next });
                }}
              />
              <input
                className="vs-input"
                style={{ flex: 1, minWidth: 0 }}
                value={t.artist ?? ""}
                placeholder="Artist"
                aria-label={`Track ${i + 1} artist`}
                onChange={(e) => {
                  const next = [...tracks];
                  next[i] = { ...next[i], artist: e.target.value };
                  onChange({ ...block, tracks: next });
                }}
              />
              <button
                type="button"
                className="vb-icon-btn"
                title="Move up"
                aria-label={`Move track ${i + 1} up`}
                disabled={i === 0}
                onClick={() => moveTrack(i, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="vb-icon-btn"
                title="Move down"
                aria-label={`Move track ${i + 1} down`}
                disabled={i === tracks.length - 1}
                onClick={() => moveTrack(i, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className={`vb-icon-btn${isProfile(i) ? " is-active" : ""}`}
                title={isProfile(i) ? "Profile song (click to unset)" : "Set as profile song"}
                aria-label={isProfile(i) ? "Unset profile song" : `Set track ${i + 1} as profile song`}
                aria-pressed={isProfile(i)}
                onClick={() =>
                  onProfileSongChange(
                    isProfile(i) ? undefined : { blockIndex, trackIndex: i },
                  )
                }
              >
                ★
              </button>
              <button
                type="button"
                className="vb-icon-btn vb-icon-btn-danger"
                title="Remove track"
                aria-label={`Remove track ${i + 1}`}
                onClick={() => removeTrack(i)}
              >
                <IconTrash size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {tracks.length === 0 && (
        <p className="vs-hint" style={{ marginTop: 8 }}>
          No tracks yet — paste a link or upload your own music above.
        </p>
      )}
    </>
  );
}

/**
 * Editor for the socials block: paste profile links (platform auto-detected
 * live as you type), per-link remove. Mirrors the music block's paste-to-add
 * pattern — no platform picker needed.
 */
function SocialsEditor({
  block,
  onChange,
}: {
  block: Extract<Block, { type: "socials" }>;
  onChange: (next: Block) => void;
}) {
  const { t } = useLanguage();
  const items = Array.isArray(block.items) ? block.items : [];
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = input.trim();
  const detected = trimmed ? detectPlatform(trimmed) : null;

  const addSocial = () => {
    const url = normalizeSocialUrl(input);
    if (!url) {
      setError(t("builder.socialsInvalid"));
      return;
    }
    setError(null);
    setInput("");
    // Already listed — skip the duplicate silently.
    if (items.some((s) => s.url === url)) return;
    onChange({ ...block, items: [...items, { platform: detectPlatform(url), url }] });
  };

  const updateUrl = (i: number, raw: string) => {
    onChange({
      ...block,
      items: items.map((s, j) =>
        j === i ? { ...s, url: raw, platform: detectPlatform(raw) } : s
      ),
    });
  };

  return (
    <>
      <span className="vs-label">{t("builder.socialsTitle")}</span>
      <p className="vs-hint" style={{ marginTop: 0 }}>
        {t("builder.socialsDesc")}
      </p>
      {items.map((s, i) => {
        const pid = isPlatformId(s.platform) ? s.platform : "website";
        return (
          <div className="vb-row" key={i}>
            <span className="vb-social-icon" title={PLATFORMS[pid].name}>
              <PlatformIcon platform={pid} size={18} />
            </span>
            <input
              className="vs-input"
              style={{ flex: 1 }}
              value={s.url}
              placeholder={t("builder.socialsPlaceholder")}
              aria-label={`${PLATFORMS[pid].name} URL`}
              onChange={(e) => updateUrl(i, e.target.value)}
            />
            <button
              type="button"
              className="vb-icon-btn vb-icon-btn-danger"
              title={t("builder.socialsRemove")}
              aria-label={`${t("builder.socialsRemove")} ${PLATFORMS[pid].name}`}
              onClick={() =>
                onChange({ ...block, items: items.filter((_, j) => j !== i) })
              }
            >
              <IconClose size={14} />
            </button>
          </div>
        );
      })}
      <div className="vb-row">
        <input
          className="vs-input"
          style={{ flex: 1 }}
          value={input}
          placeholder={t("builder.socialsPlaceholder")}
          aria-label={t("builder.socialsPlaceholder")}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addSocial();
            }
          }}
        />
        <button type="button" className="vs-btn vs-btn-ghost" onClick={addSocial}>
          <IconPlus size={16} /> {t("builder.socialsAdd")}
        </button>
      </div>
      {detected && (
        <p className="vs-hint" style={{ marginTop: 4 }}>
          {t("builder.socialsDetected")}: <strong>{PLATFORMS[detected].name}</strong>
        </p>
      )}
      {error && <p className="vb-error">{error}</p>}
      {items.length === 0 && !trimmed && (
        <p className="vs-hint">{t("builder.socialsEmpty")}</p>
      )}
    </>
  );
}

function BlockEditor({
  block,
  index,
  onChange,
  onRemove,
  profileSong,
  onProfileSongChange,
}: {
  block: Block;
  index: number;
  onChange: (next: Block) => void;
  onRemove: () => void;
  /** Page-level profile song ref (music blocks can mark one track as featured). */
  profileSong?: ProfileSongRef;
  onProfileSongChange?: (ref: ProfileSongRef | undefined) => void;
}) {
  return (
    <div className="vb-block vs-card">
      <div className="vb-block-head">
        <span className="vb-block-type">
          <BlockTypeIcon type={block.type} />
          {block.type}
        </span>
        <button
          type="button"
          className="vb-icon-btn vb-icon-btn-danger"
          onClick={onRemove}
          title={`Remove ${block.type} block`}
          aria-label={`Remove ${block.type} block`}
        >
          <IconTrash size={16} />
        </button>
      </div>

      {block.type === "hero" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Title</span>
            <VoiceInput
              className="vs-input"
              multiline={false}
              value={block.title}
              onChange={(title) => onChange({ ...block, title })}
              placeholder="Title — type or tap the mic to dictate"
              ariaLabel="Hero title"
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Subtitle</span>
            <VoiceInput
              className="vs-input"
              multiline={false}
              value={block.subtitle ?? ""}
              onChange={(subtitle) => onChange({ ...block, subtitle })}
              placeholder="Subtitle (optional)"
              ariaLabel="Hero subtitle"
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Avatar</span>
            <input
              className="vs-input"
              value={block.avatarEmoji ?? ""}
              placeholder="Avatar emoji (optional)"
              onChange={(e) => onChange({ ...block, avatarEmoji: e.target.value })}
            />
          </label>
        </>
      )}

      {block.type === "bio" && (
        <label className="vb-field">
          <span className="vs-label">Bio text</span>
          <VoiceInput
            className="vs-input"
            rows={3}
            value={block.text}
            onChange={(text) => onChange({ ...block, text })}
            placeholder="Tell your story — type or tap the mic to dictate"
            ariaLabel="Bio text"
          />
        </label>
      )}

      {block.type === "links" && (
        <>
          <span className="vs-label">Links</span>
          {block.items.map((item, i) => (
            <div className="vb-row" key={i}>
              <input
                className="vs-input"
                style={{ flex: 1 }}
                value={item.label}
                placeholder="Label"
                onChange={(e) => {
                  const items = [...block.items];
                  items[i] = { ...items[i], label: e.target.value };
                  onChange({ ...block, items });
                }}
              />
              <input
                className="vs-input"
                style={{ flex: 2 }}
                value={item.url}
                placeholder="URL"
                onChange={(e) => {
                  const items = [...block.items];
                  items[i] = { ...items[i], url: e.target.value };
                  onChange({ ...block, items });
                }}
              />
              <button
                type="button"
                className="vb-icon-btn vb-icon-btn-danger"
                onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                title="Remove link"
                aria-label="Remove link"
              >
                <IconClose size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() => onChange({ ...block, items: [...block.items, { label: "New link", url: "https://" }] })}
          >
            <IconPlus size={16} /> Add link
          </button>
        </>
      )}

      {block.type === "socials" && (
        <SocialsEditor block={block} onChange={onChange} />
      )}

      {block.type === "tipJar" && (
        <label className="vb-field">
          <span className="vs-label">Tip jar message</span>
          <input
            className="vs-input"
            value={block.message ?? ""}
            placeholder="Tip jar message (optional)"
            onChange={(e) => onChange({ ...block, message: e.target.value })}
          />
          <span className="vs-hint">
            💸 You keep 98% of every tip — 2% platform fee. The split is
            enforced on-chain, no middleman.
          </span>
        </label>
      )}

      {block.type === "heartbeat" && (
        <p className="vs-hint">
          The Blockchain Heartbeat is automatic — it shows this page&apos;s live
          connection to Hedera mainnet and pulses when real tips settle. No
          setup needed.
        </p>
      )}

      {block.type === "nftGallery" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Collection token ID</span>
            <input
              className="vs-input"
              value={block.token_id}
              maxLength={32}
              placeholder="0.0.123456"
              onChange={(e) => onChange({ ...block, token_id: e.target.value })}
              aria-label="HTS NFT collection token ID"
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Title</span>
            <input
              className="vs-input"
              value={block.title ?? ""}
              maxLength={60}
              placeholder="NFT Gallery"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
              aria-label="Gallery title"
            />
          </label>
          <p className="vs-hint">
            Paste your HTS NFT collection ID (from prepare_nft_collection).
            The block reads Hedera live — mints appear automatically, and
            buyers associate + purchase from here.
          </p>
        </>
      )}

      {block.type === "badges" && (
        <>
          <span className="vs-label">Badges</span>
          {block.items.map((item, i) => (
            <div className="vb-entry" key={i}>
              <div className="vb-entry-head">
                <input
                  className="vs-input"
                  value={item}
                  maxLength={24}
                  onChange={(e) =>
                    onChange({
                      ...block,
                      items: block.items.map((x, j) => (j === i ? e.target.value : x)),
                    })
                  }
                  aria-label={`Badge ${i + 1}`}
                />
                <button
                  type="button"
                  className="vb-icon-btn vb-icon-btn-danger"
                  onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                  title="Delete badge"
                  aria-label="Delete badge"
                >
                  <IconTrash size={14} />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() => onChange({ ...block, items: [...block.items, "Badge"] })}
          >
            <IconPlus size={16} /> Add badge
          </button>
        </>
      )}

      {block.type === "tabs" && (
        <>
          <span className="vs-label">Tabs</span>
          {block.tabs.map((t, i) => (
            <label className="vb-field" key={i}>
              <span className="vs-label">Tab {i + 1} label</span>
              <input
                className="vs-input"
                value={t.label}
                maxLength={24}
                onChange={(e) =>
                  onChange({
                    ...block,
                    tabs: block.tabs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  })
                }
              />
            </label>
          ))}
          <p className="vs-hint">
            Each tab holds its own blocks — describe what goes in a tab to the
            AI builder and it will arrange them.
          </p>
        </>
      )}

      {block.type === "guestbook" && (
        <>
          <span className="vs-label">Entries</span>
          {block.entries.map((entry, i) => (
            <div className="vb-entry" key={i}>
              <div className="vb-entry-head">
                <span>Entry {i + 1}</span>
                <button
                  type="button"
                  className="vb-icon-btn vb-icon-btn-danger"
                  onClick={() => onChange({ ...block, entries: block.entries.filter((_, j) => j !== i) })}
                  title="Delete entry"
                  aria-label="Delete guestbook entry"
                >
                  <IconTrash size={14} />
                </button>
              </div>
              <label className="vb-field">
                <span className="vs-label">Name</span>
                <input
                  className="vs-input"
                  value={entry.name}
                  placeholder="Name"
                  onChange={(e) => {
                    const entries = [...block.entries];
                    entries[i] = { ...entries[i], name: e.target.value };
                    onChange({ ...block, entries });
                  }}
                />
              </label>
              <label className="vb-field">
                <span className="vs-label">Message</span>
                <input
                  className="vs-input"
                  value={entry.message}
                  placeholder="Message"
                  onChange={(e) => {
                    const entries = [...block.entries];
                    entries[i] = { ...entries[i], message: e.target.value };
                    onChange({ ...block, entries });
                  }}
                />
              </label>
              <label className="vb-field">
                <span className="vs-label">Date</span>
                <input
                  className="vs-input"
                  value={entry.date}
                  placeholder="YYYY-MM-DD"
                  onChange={(e) => {
                    const entries = [...block.entries];
                    entries[i] = { ...entries[i], date: e.target.value };
                    onChange({ ...block, entries });
                  }}
                />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() =>
              onChange({
                ...block,
                entries: [...block.entries, { name: "", message: "", date: new Date().toISOString().slice(0, 10) }],
              })
            }
          >
            <IconPlus size={16} /> Add entry
          </button>
        </>
      )}

      {block.type === "music" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Title</span>
            <input
              className="vs-input"
              value={block.title ?? ""}
              placeholder="Title (optional)"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </label>
          <MusicTrackEditor
            block={block}
            blockIndex={index}
            onChange={onChange}
            profileSong={profileSong}
            onProfileSongChange={(ref) => onProfileSongChange?.(ref)}
          />
        </>
      )}

      {block.type === "livestream" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Title</span>
            <input
              className="vs-input"
              value={block.title ?? ""}
              placeholder="Title (optional)"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Platform</span>
            <select
              className="vs-input"
              value={block.platform}
              onChange={(e) =>
                onChange({ ...block, platform: e.target.value as "twitch" | "youtube" })
              }
              aria-label="Livestream platform"
            >
              <option value="twitch">Twitch</option>
              <option value="youtube">YouTube</option>
            </select>
          </label>
          <label className="vb-field">
            <span className="vs-label">Channel</span>
            <input
              className="vs-input"
              value={block.channel}
              placeholder={block.platform === "twitch" ? "your_twitch_name" : "UCxxxxxxxxxxxxxxxxxxxxxx"}
              onChange={(e) => onChange({ ...block, channel: e.target.value })}
            />
            <span className="vs-hint">
              {block.platform === "twitch"
                ? "Twitch: your channel name (letters, numbers, underscores)."
                : "YouTube: your UC… channel ID (not the @handle — find it in YouTube Studio → Settings → Channel)."}
            </span>
          </label>
        </>
      )}

      {block.type === "gallery" && (
        <>
          <span className="vs-label">Images</span>
          {block.images.map((img, i) => (
            <div className="vb-row" key={i}>
              <input
                className="vs-input"
                style={{ flex: 1 }}
                value={img}
                placeholder="Emoji (or :logo: for the Voicescape logo)"
                onChange={(e) => {
                  const images = [...block.images];
                  images[i] = e.target.value;
                  onChange({ ...block, images });
                }}
              />
              <button
                type="button"
                className="vb-icon-btn vb-icon-btn-danger"
                onClick={() => onChange({ ...block, images: block.images.filter((_, j) => j !== i) })}
                title="Remove image"
                aria-label="Remove image"
              >
                <IconClose size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() => onChange({ ...block, images: [...block.images, "✨"] })}
          >
            <IconPlus size={16} /> Add image
          </button>
          <div className="vb-row" style={{ marginTop: 8, alignItems: "center" }}>
            <span className="vs-label" style={{ margin: 0 }}>
              Motion
            </span>
            <select
              className="vs-input"
              style={{ flex: 1 }}
              value={block.effect ?? ""}
              onChange={(e) => {
                const v = e.target.value as "" | "dance" | "marquee" | "float";
                onChange({ ...block, effect: v || undefined });
              }}
              aria-label="Gallery motion effect"
            >
              <option value="">None</option>
              <option value="dance">Dance</option>
              <option value="marquee">Marquee</option>
              <option value="float">Float</option>
            </select>
          </div>
        </>
      )}

      {block.type === "services" && (
        <>
          <span className="vs-label">Services (pay per call)</span>
          {block.items.map((s, i) => (
            <div className="vb-entry" key={i}>
              <div className="vb-entry-head">
                <span>Service {i + 1}</span>
                <button
                  type="button"
                  className="vb-icon-btn vb-icon-btn-danger"
                  onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                  title="Delete service"
                  aria-label="Delete service"
                >
                  <IconTrash size={14} />
                </button>
              </div>
              {(
                [
                  ["name", "Name", "Summarize URL", false],
                  ["description", "Description", "What the endpoint does — type or dictate", true],
                  ["endpoint", "Endpoint URL", "https://…", false],
                ] as const
              ).map(([key, label, ph, voice]) => (
                <label className="vb-field" key={key}>
                  <span className="vs-label">{label}</span>
                  {voice ? (
                    <VoiceInput
                      className="vs-input"
                      multiline={false}
                      value={s[key]}
                      placeholder={ph}
                      ariaLabel={label}
                      onChange={(v) => {
                        const items = [...block.items];
                        items[i] = { ...items[i], [key]: v };
                        onChange({ ...block, items });
                      }}
                    />
                  ) : (
                    <input
                      className="vs-input"
                      value={s[key]}
                      placeholder={ph}
                      onChange={(e) => {
                        const items = [...block.items];
                        items[i] = { ...items[i], [key]: e.target.value };
                        onChange({ ...block, items });
                      }}
                    />
                  )}
                </label>
              ))}
              <label className="vb-field">
                <span className="vs-label">Price (USD cents)</span>
                <input
                  className="vs-input"
                  inputMode="numeric"
                  value={String(s.priceUsdCents)}
                  placeholder="100"
                  onChange={(e) => {
                    const v = Math.max(0, Math.floor(Number(e.target.value.replace(/[^0-9]/g, "")) || 0));
                    const items = [...block.items];
                    items[i] = { ...items[i], priceUsdCents: v };
                    onChange({ ...block, items });
                  }}
                />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() =>
              onChange({
                ...block,
                items: [...block.items, { name: "New service", description: "", priceUsdCents: 100, endpoint: "https://" }],
              })
            }
          >
            <IconPlus size={16} /> Add service
          </button>
        </>
      )}

      {block.type === "capabilities" && (
        <>
          <span className="vs-label">Capabilities (machine-readable tags)</span>
          {block.items.map((c, i) => (
            <div className="vb-row" key={i}>
              <input
                className="vs-input vs-mono"
                style={{ flex: 1 }}
                value={c}
                placeholder="e.g. summarization"
                onChange={(e) => {
                  const items = [...block.items];
                  items[i] = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
                  onChange({ ...block, items });
                }}
              />
              <button
                type="button"
                className="vb-icon-btn vb-icon-btn-danger"
                onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                title="Remove capability"
                aria-label="Remove capability"
              >
                <IconClose size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() => onChange({ ...block, items: [...block.items, "new-capability"] })}
          >
            <IconPlus size={16} /> Add capability
          </button>
        </>
      )}

      {block.type === "operator" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Operator wallet</span>
            <input
              className="vs-input vs-mono"
              value={block.wallet}
              placeholder="0x… or 0.0.x"
              onChange={(e) => onChange({ ...block, wallet: e.target.value })}
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Operator name (optional)</span>
            <input
              className="vs-input"
              value={block.name ?? ""}
              placeholder="Who runs this agent"
              onChange={(e) => onChange({ ...block, name: e.target.value })}
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Operator URL (optional)</span>
            <input
              className="vs-input"
              value={block.url ?? ""}
              placeholder="https://…"
              onChange={(e) => onChange({ ...block, url: e.target.value })}
            />
          </label>
        </>
      )}

      {block.type === "reviews" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Section title</span>
            <input
              className="vs-input"
              value={block.title ?? ""}
              placeholder="Reviews"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </label>
          <span className="vs-label">Entries</span>
          {block.entries.map((entry, i) => (
            <div className="vb-entry" key={i}>
              <div className="vb-entry-head">
                <span>Review {i + 1}</span>
                <button
                  type="button"
                  className="vb-icon-btn vb-icon-btn-danger"
                  onClick={() => onChange({ ...block, entries: block.entries.filter((_, j) => j !== i) })}
                  title="Delete review"
                  aria-label="Delete review"
                >
                  <IconTrash size={14} />
                </button>
              </div>
              {(
                [
                  ["name", "Name", "Name"],
                  ["message", "Message", "Message"],
                  ["date", "Date", "YYYY-MM-DD"],
                  ["txHash", "Payment tx hash (optional)", "0.0.x@… — links to HashScan proof"],
                ] as const
              ).map(([key, label, ph]) => (
                <label className="vb-field" key={key}>
                  <span className="vs-label">{label}</span>
                  <input
                    className={`vs-input${key === "txHash" ? " vs-mono" : ""}`}
                    value={entry[key] ?? ""}
                    placeholder={ph}
                    onChange={(e) => {
                      const entries = [...block.entries];
                      entries[i] = { ...entries[i], [key]: e.target.value };
                      onChange({ ...block, entries });
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() =>
              onChange({
                ...block,
                entries: [...block.entries, { name: "", message: "", date: new Date().toISOString().slice(0, 10) }],
              })
            }
          >
            <IconPlus size={16} /> Add review
          </button>
        </>
      )}

      {block.type === "booking" && (
        <>
          <label className="vb-field">
            <span className="vs-label">Section title</span>
            <input
              className="vs-input"
              value={block.title ?? ""}
              placeholder="Book me"
              onChange={(e) => onChange({ ...block, title: e.target.value })}
            />
          </label>
          <span className="vs-label">Booking links</span>
          {block.items.map((item, i) => (
            <div className="vb-entry" key={i}>
              <div className="vb-entry-head">
                <span>Link {i + 1}</span>
                <button
                  type="button"
                  className="vb-icon-btn vb-icon-btn-danger"
                  onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })}
                  title="Delete booking link"
                  aria-label="Delete booking link"
                >
                  <IconTrash size={14} />
                </button>
              </div>
              <label className="vb-field">
                <span className="vs-label">Label</span>
                <input
                  className="vs-input"
                  value={item.label}
                  placeholder="Label"
                  onChange={(e) => {
                    const items = [...block.items];
                    items[i] = { ...items[i], label: e.target.value };
                    onChange({ ...block, items });
                  }}
                />
              </label>
              <label className="vb-field">
                <span className="vs-label">URL</span>
                <input
                  className="vs-input"
                  value={item.url}
                  placeholder="https://…"
                  onChange={(e) => {
                    const items = [...block.items];
                    items[i] = { ...items[i], url: e.target.value };
                    onChange({ ...block, items });
                  }}
                />
              </label>
              <label className="vb-field">
                <span className="vs-label">Note (optional)</span>
                <input
                  className="vs-input"
                  value={item.note ?? ""}
                  placeholder="e.g. $50 / 30 min"
                  onChange={(e) => {
                    const items = [...block.items];
                    items[i] = { ...items[i], note: e.target.value };
                    onChange({ ...block, items });
                  }}
                />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            onClick={() => onChange({ ...block, items: [...block.items, { label: "New booking link", url: "https://" }] })}
          >
            <IconPlus size={16} /> Add booking link
          </button>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Theme editor                                                      */
/* ---------------------------------------------------------------- */

function ThemeEditor({
  theme,
  onChange,
}: {
  theme: VoicescapePage["theme"];
  onChange: (key: keyof VoicescapePage["theme"], value: string) => void;
}) {
  const colors = [
    ["background", "Background"],
    ["foreground", "Foreground"],
    ["accent", "Accent"],
  ] as const;
  return (
    <div className="vb-theme vs-card">
      <div className="vb-panel-title">Theme</div>
      {colors.map(([key, label]) => (
        <div className="vb-theme-row" key={key}>
          <span className="vs-label">{label}</span>
          <label className="vb-swatch" style={{ background: theme[key] }} title={`Pick ${label.toLowerCase()} color`}>
            <input
              type="color"
              value={theme[key]}
              aria-label={`${label} color`}
              onChange={(e) => onChange(key, e.target.value)}
            />
          </label>
          <code className="vs-mono vb-hex">{theme[key]}</code>
        </div>
      ))}
      <label className="vb-field">
        <span className="vs-label">Font</span>
        <select className="vs-input" value={theme.fontFamily} onChange={(e) => onChange("fontFamily", e.target.value)}>
          {[
            "Arial, Helvetica, sans-serif",
            "Georgia, serif",
            "monospace",
            "Comic Sans MS, cursive",
            "Impact, sans-serif",
          ].map((f) => (
            <option key={f} value={f}>
              {shortFont(f)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Name-first claim (2026-09-28): pick the blockpage name BEFORE the     */
/* wallet connects. Inline availability via /api/resolve, debounced.    */
/* ---------------------------------------------------------------- */

type NameAvailability = "idle" | "checking" | "available" | "taken" | "mine" | "error";

/** True when an on-chain owner address and a wallet account id are the same. */
function sameOnchainOwner(ownerAddr: string, account: string): boolean {
  const o = ownerAddr.trim().toLowerCase();
  const a = account.trim().toLowerCase();
  if (!o || !a) return false;
  if (o === a) return true;
  if (/^0\.0\.\d+$/.test(a)) {
    try {
      const asEvm = "0x" + BigInt(a.slice(4)).toString(16).padStart(40, "0");
      if (o === asEvm) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Debounced on-chain availability for a candidate blockpage name.
 * "mine" = taken, but the connected wallet owns it (publish will update).
 */
function useUsernameAvailability(name: string, account: string | null): NameAvailability {
  const [state, setState] = useState<NameAvailability>("idle");
  useEffect(() => {
    const candidate = name.trim().toLowerCase();
    if (!isValidUsername(candidate)) {
      setState("idle");
      return;
    }
    setState("checking");
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetchWithTimeout(`/api/resolve?username=${encodeURIComponent(candidate)}`, 10_000, {
          cache: "no-store",
        });
        if (cancelled) return;
        // 404 = name not registered = available. Any other non-OK is a
        // failed check, never "available".
        if (res.status === 404) {
          setState("available");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        if (account) {
          try {
            const data = (await res.json()) as { owner?: string };
            if (data.owner && sameOnchainOwner(data.owner, account)) {
              setState("mine");
              return;
            }
          } catch {
            /* fall through to taken */
          }
        }
        setState("taken");
      } catch {
        if (!cancelled) setState("error");
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, account]);
  return state;
}

/** Shared blockpage-name field: sanitized input + inline availability. */
function UsernameField({
  username,
  onChange,
  account,
  availability,
  label,
  hint,
}: {
  username: string;
  onChange: (v: string) => void;
  account: string | null;
  availability: NameAvailability;
  label: string;
  hint?: string;
}) {
  const trimmed = username.trim().toLowerCase();
  const valid = isValidUsername(trimmed);
  return (
    <div className="vb-field">
      <span className="vs-label">{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        <span className="vs-mono" style={{ fontSize: 15, color: "var(--vs-muted)" }}>
          /
        </span>
        <input
          className="vs-input vs-mono"
          value={username}
          onChange={(e) =>
            onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24))
          }
          placeholder="your-name"
          // 16px minimum — iOS Safari auto-zooms on smaller inputs.
          style={{ fontSize: 16 }}
          aria-label="Blockpage name"
          autoComplete="off"
          spellCheck={false}
        />
        <span style={{ marginLeft: 8, fontSize: 16 }} aria-hidden="true">
          {availability === "checking"
            ? "…"
            : availability === "available" || availability === "mine"
              ? "✅"
              : availability === "taken"
                ? "❌"
                : ""}
        </span>
      </div>
      {hint && <div className="vb-info-hint">{hint}</div>}
      {!valid && username.length > 0 && (
        <div className="vb-username-hint">Use 3–24 lowercase letters, numbers, or hyphens.</div>
      )}
      {/* aria-live: the emoji status is aria-hidden; announce checking as text. */}
      <div
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {valid && availability === "checking" ? "Checking name availability…" : ""}
      </div>
      {valid && availability === "available" && (
        <div className="vb-username-hint" style={{ color: "var(--vs-ok, #4ade80)" }}>
          ✅ <span className="vs-mono">/{trimmed}</span> is available — it&apos;s yours when you publish.
        </div>
      )}
      {valid && availability === "mine" && (
        <div className="vb-username-hint" style={{ color: "var(--vs-ok, #4ade80)" }}>
          ✅ <span className="vs-mono">/{trimmed}</span> is already yours — publishing updates it.
        </div>
      )}
      {valid && availability === "taken" && (
        <div className="vb-username-hint" style={{ color: "var(--vs-err, #f87171)" }}>
          That name is taken — try another.
        </div>
      )}
      {valid && availability === "error" && (
        <div className="vb-username-hint">
          Couldn&apos;t check availability — the network decides at publish.
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Dismissable progress checklist (2026-09-28): endowed progress —   */
/* template + preview start checked; everything is skippable.        */
/* ---------------------------------------------------------------- */

const CHECKLIST_DISMISS_KEY = "vs-builder-checklist-dismissed";

function ChecklistCard({
  nameDone,
  walletDone,
  publishedDone,
}: {
  nameDone: boolean;
  walletDone: boolean;
  publishedDone: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(CHECKLIST_DISMISS_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  if (dismissed) return null;
  // Quick-build (2026-09-29): 3 real items. The old "Pick a template" and
  // "See it live in the preview" entries were hardcoded done:true — a padded
  // checklist is noise, not progress.
  const items = [
    { label: "Name your page", done: nameDone },
    { label: "Connect your wallet to claim it", done: walletDone },
    { label: "Publish & share your link", done: publishedDone },
  ];
  const doneCount = items.filter((i) => i.done).length;
  return (
    <div className="vs-card" role="note" aria-label="Your progress" style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: 14 }}>
          Your blockpage {doneCount}/{items.length}
        </strong>
        <button
          type="button"
          className="vb-quiet-link"
          aria-label="Dismiss checklist"
          onClick={() => {
            try {
              localStorage.setItem(CHECKLIST_DISMISS_KEY, "1");
            } catch {
              /* ignore */
            }
            setDismissed(true);
          }}
        >
          ✕
        </button>
      </div>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, fontSize: 13 }}>
        {items.map((item) => (
          <li
            key={item.label}
            style={{
              padding: "3px 0",
              color: item.done ? "var(--vs-muted)" : "var(--vs-text)",
            }}
          >
            {item.done ? "✅" : "⬜"} {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* HashPack profile import (2026-09-28): one-tap pre-fill from the    */
/* free HashPack Profile API (HNS name, bio, X handle). Skippable.    */
/* ---------------------------------------------------------------- */

interface HashpackProfile {
  username: string | null;
  bio: string | null;
  twitterHandle: string | null;
}

function HashpackProfileImport({
  account,
  onUseName,
  onUseDisplayName,
}: {
  account: string;
  onUseName: (name: string) => void;
  onUseDisplayName: (displayName: string) => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "empty" | "error" | "dismissed">(
    "idle",
  );
  const [profile, setProfile] = useState<HashpackProfile | null>(null);

  if (state === "dismissed") return null;

  const load = async () => {
    setState("loading");
    try {
      const res = await fetchWithTimeout(
        `/api/hashpack-profile?account=${encodeURIComponent(account)}`,
        10_000,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("lookup failed");
      const data = (await res.json()) as HashpackProfile;
      if (!data.username && !data.bio && !data.twitterHandle) {
        setState("empty");
        return;
      }
      setProfile(data);
      setState("done");
    } catch {
      setState("error");
    }
  };

  // HNS names look like "brandon.hbar" — the registry wants the bare label.
  const bareName =
    profile?.username?.split(".")[0]?.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) ?? "";
  const nameUsable = bareName.length > 0 && isValidUsername(bareName);

  return (
    <div className="vb-info-hint" style={{ marginTop: 8 }}>
      {state === "idle" && (
        <button type="button" className="vb-quiet-link" onClick={load}>
          ✨ Import my HashPack profile
        </button>
      )}
      {state === "loading" && <span>Looking up your HashPack profile…</span>}
      {state === "empty" && <span>No HashPack profile found for this wallet — no problem.</span>}
      {state === "error" && <span>Couldn&apos;t reach the profile service — you can type everything manually.</span>}
      {state === "done" && profile && (
        <span>
          Found{profile.username ? <strong> @{profile.username}</strong> : " your profile"}
          {nameUsable && (
            <>
              {" — "}
              <button
                type="button"
                className="vb-quiet-link"
                onClick={() => {
                  onUseName(bareName);
                  setState("dismissed");
                }}
              >
                use “{bareName}” as my page name
              </button>
            </>
          )}
          {profile.username && (
            <>
              {" · "}
              <button
                type="button"
                className="vb-quiet-link"
                onClick={() => {
                  onUseDisplayName(profile.username as string);
                  setState("dismissed");
                }}
              >
                use as display name
              </button>
            </>
          )}{" "}
          <button
            type="button"
            className="vb-quiet-link"
            aria-label="Dismiss profile import"
            onClick={() => setState("dismissed")}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Template picker                                                   */
/* ---------------------------------------------------------------- */

function TemplatePicker({
  activeId,
  onPick,
  account,
  liaisonDraft,
  onPickLiaisonDraft,
}: {
  activeId: string;
  onPick: (t: Template) => void;
  /** Connected wallet account id (0.0.x or 0x…) — owner-gated templates stay hidden without it. */
  account: string | null;
  /** The user's wallet-bound liaison draft, if one exists. */
  liaisonDraft?: { draftId: string; usernameHint: string | null; templateId: string } | null;
  /** Load the liaison draft into the canvas. */
  onPickLiaisonDraft?: () => void;
}) {
  const [category, setCategory] = useState<"business" | "personal">("personal");
  const filtered = TEMPLATES.filter((t) => t.category === category && isTemplateVisible(t, account));
  return (
    <div>
      <div className="vb-panel-title">Template</div>
      {/* Liaison slice-1: the wallet-bound premade blockpage Danny built for
          this user sits above the grid. Selecting it loads their draft JSON
          into the canvas. */}
      {liaisonDraft && onPickLiaisonDraft && (
        <button
          type="button"
          onClick={onPickLiaisonDraft}
          title="A premade blockpage Danny built for your wallet — only you can see it"
          className="vb-template-card"
          style={{ borderColor: "var(--vs-accent, #38bdf8)", marginBottom: 10, width: "100%" }}
        >
          <span
            className="vb-template-swatch"
            style={{
              background: "linear-gradient(135deg, #38bdf8 0%, #a78bfa 55%, #f472b6 100%)",
            }}
          />
          <span className="vb-template-name">✨ Made for you</span>
          <span className="vb-template-desc">
            Danny&apos;s draft{liaisonDraft.usernameHint ? ` · @${liaisonDraft.usernameHint}` : ""} — bound to your wallet
          </span>
        </button>
      )}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "var(--vs-muted)" }}>
          Blockpage type
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as "business" | "personal")}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            color: "var(--vs-text)",
            fontSize: 14,
          }}
        >
          <option value="personal">Personal</option>
          <option value="business">Business</option>
        </select>
      </div>
      <div className="vb-template-grid">
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t)}
            title={t.description}
            className={`vb-template-card${t.id === activeId ? " is-selected" : ""}`}
            style={{ "--vb-accent": t.page.theme.accent } as React.CSSProperties}
          >
            <span
              className="vb-template-swatch"
              style={{
                background: `linear-gradient(135deg, ${t.page.theme.background} 0%, ${t.page.theme.accent} 55%, ${t.page.theme.foreground} 100%)`,
              }}
            />
            <span className="vb-template-name">{t.name}</span>
            <span className="vb-template-desc">{t.description}</span>
            {t.id === activeId && (
              <span className="vb-template-check">
                <IconCheck size={14} />
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Vibecode chat panel                                               */
/* ---------------------------------------------------------------- */

interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
  /** Optional verification link rendered under the bubble (e.g. HashScan receipt). */
  link?: { href: string; label: string };
}

const SUGGESTIONS = [
  "make it neon cyberpunk",
  "add a links section with my GitHub",
  "make it brutalist and loud",
  "add a guestbook block",
  "give the hero a bolder title",
];

function VibecodeChat({
  page,
  draft,
  onDraftChange,
  onApplyDraft,
  onDiscardDraft,
}: {
  page: VoicescapePage;
  draft: AiDraft | null;
  onDraftChange: (d: AiDraft | null) => void;
  onApplyDraft: () => void;
  onDiscardDraft: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Hey! Describe how you want your blockpage to look and I'll draft a new version — you review it in the preview, then apply or discard.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Two ways to pay for AI edits — both paid by the user, never by the app:
  // "byok" calls Anthropic directly from this browser with the user's own
  // API key; "x402" pays the x402 vibecode endpoint per edit from the
  // wallet. There is no server-paid AI path.
  const x402Url = getX402VibecodeUrl();
  // Default to pay-per-edit (x402) — the simpler path for first-timers with
  // no API key. Falls back to BYOK when a key is already stored or x402 is
  // not configured.
  const [payMode, setPayMode] = useState<"byok" | "x402">(() =>
    hasByokKey() || !x402Url ? "byok" : "x402",
  );
  const [x402Rails, setX402Rails] = useState<X402Rail[] | null>(null);
  const [x402Rail, setX402Rail] = useState<X402Rail | null>(null);
  const [x402Pending, setX402Pending] = useState<string | null>(null);
  // Round-2 simplify (2026-09-28): the rail picker is collapsed by default —
  // the cheapest rail is auto-selected, humans never choose between payment
  // methods for the same edit.
  const [showRails, setShowRails] = useState(false);
  const [x402Note, setX402Note] = useState<{ kind: "info" | "err" | "ok"; text: string } | null>(null);
  // Human-first claim flow (Brandon 2026-09-27): AI pay-per-edit needs the
  // wallet — to pay, and to make the page theirs. BYOK stays wallet-free
  // (their key, their spend).
  const { isAuthenticated } = useSession();

  // BYOK key state. The key lives ONLY in this browser's localStorage —
  // it is never sent to our server.
  const [byokHasKey, setByokHasKey] = useState<boolean>(() => hasByokKey());
  const [byokInput, setByokInput] = useState("");
  const [byokSettingsOpen, setByokSettingsOpen] = useState(false);
  const [byokNote, setByokNote] = useState<{ kind: "info" | "err" | "ok"; text: string } | null>(null);

  // Block types the x402 vibecode SERVICE currently accepts. Its schema is a
  // copy of ours ("keep in sync" per its schema.ts) — warn before paying if
  // the page uses newer block types, since the service would reject the
  // request after the payment has settled.
  const X402_KNOWN_BLOCKS = [
    "hero",
    "bio",
    "links",
    "socials",
    "tipJar",
    "guestbook",
    "music",
    "gallery",
    "top8",
    "services",
    "capabilities",
    "operator",
    "reviews",
    "booking",
    "livestream",
    "chat",
    "heartbeat",
    "tabs",
    "badges",
  ];
  const unknownToX402 = page.blocks.map((b) => b.type).filter((t) => !X402_KNOWN_BLOCKS.includes(t));

  /**
   * BYOK mode: call Anthropic DIRECTLY from the browser with the user's own
   * key. The Voicescape server is not involved — no proxy, no spend on our
   * side. Billed by Anthropic to the key owner.
   */
  const sendByok = async (instruction: string) => {
    const key = getByokKey();
    if (!key) {
      setByokSettingsOpen(true);
      setMessages((m) => [
        ...m,
        {
          role: "error",
          text: "Add your Anthropic API key in the AI key settings below first — generations use your key and are billed by Anthropic to you.",
        },
      ]);
      return;
    }
    setLoading(true);
    try {
      const pageJson = await generatePageWithByokKey({ pageJson: page, instruction, apiKey: key });
      const summary = summarizeChanges(page, pageJson);
      onDraftChange({ page: pageJson, summary, instruction });
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "Drafted a new version — review it in the preview pane, then Apply or Discard." },
      ]);
    } catch (e) {
      const msg =
        e instanceof ByokError ? e.message : e instanceof Error ? e.message : String(e);
      setMessages((m) => [...m, { role: "error", text: msg }]);
    } finally {
      setLoading(false);
    }
  };

  const saveByokKey = () => {
    try {
      setByokKey(byokInput);
      setByokHasKey(true);
      setByokInput("");
      setByokNote({ kind: "ok", text: "Key saved in this browser only. It is never sent to our server." });
    } catch (e) {
      setByokNote({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const removeByokKey = () => {
    clearByokKey();
    setByokHasKey(false);
    setByokNote({ kind: "info", text: "Key removed from this browser." });
  };

  /** x402 mode step 1: probe the endpoint's 402 for rails + price. */
  const startX402 = async (instruction: string) => {
    if (!x402Url) {
      setX402Note({ kind: "err", text: "NEXT_PUBLIC_X402_VIBECODE_URL is not set — pay-per-edit is unavailable." });
      return;
    }
    setX402Note(null);
    setX402Rails(null);
    setX402Rail(null);
    setShowRails(false);
    setX402Pending(instruction);
    setLoading(true);
    try {
      const probe = await probeX402(x402Url);
      setX402Rails(probe.rails);
      // Round-2 simplify: default to the cheapest rail so a human never has
      // to choose between payment methods for the same edit.
      const cheapest =
        [...probe.rails].sort(
          (a, b) => (a.usdCents ?? Number.POSITIVE_INFINITY) - (b.usdCents ?? Number.POSITIVE_INFINITY),
        )[0] ?? null;
      setX402Rail(cheapest);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "Each AI edit costs a small fee. Your wallet signs one transfer, the AI drafts your changes, and you review before anything goes live." },
      ]);
    } catch (e) {
      setX402Note({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  /** x402 mode step 2: pay on the chosen rail and fetch the edited page. */
  const payX402Edit = async () => {
    if (!x402Url || !x402Rail || !x402Pending) return;
    setX402Note(null);
    setLoading(true);
    try {
      const pairing = getHederaPairing();
      if (!pairing) throw new Error("Connect a Hedera wallet (HashPack / Blade / WalletConnect) to pay.");
      const { getActiveChain } = await import("@/lib/chains");
      const activeChain = getActiveChain();
      const network = "mainnet"; // mainnet only — no testnet
      const signer = createWalletHederaSigner(pairing.accountId, async (tx) => {
        // Serialize to base64 — avoids hiero-sdk/hashgraph-sdk type friction.
        const txBytes = tx.toBytes();
        let binary = "";
        txBytes.forEach((b) => { binary += String.fromCharCode(b); });
        const txB64 = btoa(binary);
        const result = await (pairing.hc.signTransaction as unknown as (params: object) => Promise<unknown>)({
          signerAccountId: `hedera:${network}:${pairing.accountId}`,
          transactionBody: txB64,
        });
        const { Transaction } = await import("@hiero-ledger/sdk");
        if (result instanceof Transaction) {
          return result;
        }
        throw new Error("Wallet did not return a signed transaction.");
      });
      setX402Note({ kind: "info", text: `Paying ${x402Rail.amountDisplay} — approve the transfer in your wallet…` });
      const { response, settleTxId } = await payX402(
        x402Url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageJson: page, instruction: x402Pending }),
        },
        x402Rail,
        signer,
      );
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Vibecode service returned ${response.status}: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text) as { pageJson?: unknown; error?: string };
      if (data.error || !isValidPage(data.pageJson)) {
        throw new Error(data.error ?? "The service returned an invalid blockpage.");
      }
      const summary = summarizeChanges(page, data.pageJson);
      onDraftChange({ page: data.pageJson, summary, instruction: x402Pending });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Paid edit settled${settleTxId ? ` (tx ${settleTxId.slice(0, 20)}…)` : ""} Review the draft in the preview pane, then Apply or Discard.`,
          link: settleTxId
            ? { href: `${getActiveChain().blockExplorer}/transaction/${settleTxId}`, label: "View on HashScan →" }
            : undefined,
        },
      ]);
      setX402Pending(null);
      setX402Rails(null);
    } catch (e) {
      setX402Note({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  const send = async (override?: string) => {
    const instruction = (override ?? input).trim();
    if (!instruction || loading) return;
    // Human-first gate: pay-per-edit AI needs the wallet (to pay and to
    // claim the page). The typed text stays in the box — nothing is lost.
    if (payMode === "x402" && !isAuthenticated) {
      setX402Note({
        kind: "info",
        text: "Connect your wallet to use AI edits — that's also what makes this blockpage yours.",
      });
      return;
    }
    setInput("");
    setMessages((m) => [...m, { role: "user", text: instruction }]);
    if (payMode === "x402") {
      await startX402(instruction);
    } else {
      await sendByok(instruction);
    }
  };


  const showSuggestions = messages.length <= 1 && !loading && !draft;
  // Quick-build one-tap: the AI designs from the pasted socials. Always
  // visible; disabled with a hint until there's at least one link.
  const designLinkCount = socialsUrls(page).length;

  return (
    <div className="vb-chat vs-card">
      <div className="vb-chat-head">
        <span className="vb-spark">
          <IconSpark size={16} />
        </span>
        Vibecode AI
      </div>

      <div style={{ padding: "10px 12px 0" }}>
        <button
          type="button"
          className="vs-btn vs-btn-primary"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={() => send(buildDesignFromLinksInstruction(page))}
          disabled={loading || designLinkCount === 0}
          title={
            designLinkCount > 0
              ? "The AI designs a full page from your pasted links — same price as a typed edit"
              : "Paste some links into your socials block first (Customize tab)"
          }
        >
          ✨ Design my page from my links
        </button>
        {designLinkCount === 0 && (
          <p className="vs-hint" style={{ marginTop: 6 }}>
            Paste your social links into the socials block first — the AI designs from those.
          </p>
        )}
      </div>

      <div className="vb-chat-log">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`vb-bubble ${
              m.role === "user" ? "vb-bubble-user" : m.role === "error" ? "vb-bubble-error" : "vb-bubble-assistant"
            }`}
          >
            {m.text}
            {m.link && (
              <div style={{ marginTop: 6 }}>
                <a
                  href={m.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#8fd6ff", textDecoration: "underline", fontSize: 13 }}
                >
                  {m.link.label}
                </a>
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="vb-dreaming">
            <span className="vb-dreaming-orb" />
            <span className="vb-shimmer-text">dreaming up your blockpage…</span>
          </div>
        )}
        {draft && (
          <div className="vb-draft-summary">
            <div className="vb-draft-summary-title">
              <IconSpark size={14} /> Proposed changes
            </div>
            <ul>
              {draft.summary.map((s, i) => (
                <li key={i}>
                  <IconCheck size={14} />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <div className="vb-draft-summary-actions">
              <button type="button" className="vs-btn vs-btn-primary" onClick={onApplyDraft}>
                <IconCheck size={14} /> Apply
              </button>
              <button type="button" className="vs-btn vs-btn-ghost" onClick={onDiscardDraft}>
                <IconClose size={14} /> Discard
              </button>
            </div>
          </div>
        )}
      </div>
      {showSuggestions && (
        <div className="vb-chips">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className="vb-chip-btn"
              onClick={() => send(s)}
              disabled={loading}
            >
              <IconSpark size={13} /> {s}
            </button>
          ))}
        </div>
      )}

      <div className="vb-chat-input-row">
        <input
          className="vs-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Describe a change…"
          disabled={loading}
        />
        <button type="button" className="vs-btn vs-btn-primary" onClick={() => send()} disabled={loading || !input.trim()}>
          <IconArrowRight size={16} />
        </button>
      </div>

      {/* Human-first (Brandon 2026-09-27): describe first, pay second. The
          payment box lives below the input. Pay-per-edit needs the wallet
          (to pay, and to make the page theirs); BYOK stays wallet-free
          behind the quiet Advanced link. No jargon: no "x402", no "rail". */}
      {payMode === "byok" ? (
        <div className="vb-x402-box" aria-live="polite">
          <p className="vb-x402-status">
            🔒 <strong>Advanced:</strong> AI generation uses your own Anthropic API key — billed
            by Anthropic to you, key stays in this browser. No key? Use pay-per-edit instead.
            Voicescape never sees your key and never pays for your generations.
          </p>
          <button
            type="button"
            className="vb-chip-btn"
            onClick={() => setByokSettingsOpen((o) => !o)}
            disabled={loading}
            aria-expanded={byokSettingsOpen}
          >
            {byokHasKey ? "✅ Key saved" : "➕ Add API key"}
          </button>
          {byokSettingsOpen && (
            <div style={{ marginTop: 8 }}>
              <input
                className="vs-input"
                type="password"
                value={byokInput}
                onChange={(e) => setByokInput(e.target.value)}
                placeholder="sk-ant-…"
                autoComplete="off"
                disabled={loading}
                style={{ width: "100%", marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="vs-btn vs-btn-primary"
                  onClick={saveByokKey}
                  disabled={loading || !byokInput.trim()}
                >
                  Save key
                </button>
                {byokHasKey && (
                  <button
                    type="button"
                    className="vs-btn vs-btn-ghost"
                    onClick={removeByokKey}
                    disabled={loading}
                  >
                    Remove key
                  </button>
                )}
              </div>
              <p className="vb-x402-status" style={{ marginTop: 8 }}>
                Stored only in this browser&apos;s local storage — it never leaves your device for our
                servers. Get a key at{" "}
                <a href={BYOK_CONSOLE_URL} target="_blank" rel="noreferrer">
                  console.anthropic.com
                </a>{" "}
                (model: {DEFAULT_BYOK_MODEL}).
              </p>
              {byokNote && (
                <p className={`vb-x402-status is-${byokNote.kind}`}>
                  {byokNote.kind === "err" ? "❌ " : byokNote.kind === "ok" ? "✅ " : "ℹ️ "}
                  {byokNote.text}
                </p>
              )}
            </div>
          )}
        </div>
      ) : isAuthenticated ? (
        <div className="vb-x402-box" aria-live="polite">
          {unknownToX402.length > 0 && (
            <p className="vb-x402-status is-err">
              ⚠️ This blockpage uses block types the AI service doesn&apos;t know yet (
              {unknownToX402.join(", ")}) — it would reject the request <em>after</em> you pay.
              Remove them or use your own AI key for this edit.
            </p>
          )}
          <p className="vb-x402-status">
            Each AI edit costs a small fee. You pay from your wallet, then review the draft before anything changes.
          </p>
          {x402Rails && x402Pending && (
            <>
              {/* Round-2 simplify: the selected (cheapest) rail is shown as a
                  quiet line; the full picker hides behind "change payment
                  method" instead of confronting every first-timer. */}
              {x402Rail && (
                <p className="vb-x402-status">
                  Paying with <strong>{x402Rail.label}</strong> · {x402Rail.amountDisplay}
                  {x402Rails.length > 1 && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="vb-quiet-link"
                        onClick={() => setShowRails((s) => !s)}
                        disabled={loading}
                        style={{ fontSize: "inherit" }}
                      >
                        {showRails ? "hide options" : "change payment method"}
                      </button>
                    </>
                  )}
                </p>
              )}
              {showRails && x402Rails.length > 1 && (
                <div className="pv-rail-row" role="group" aria-label="Payment method">
                  {x402Rails.map((r) => {
                    const cheapestCents = Math.min(...x402Rails.map((x) => x.usdCents ?? Number.POSITIVE_INFINITY));
                    const isCheapest = x402Rails.length > 1 && r.usdCents === cheapestCents;
                    return (
                      <button
                        key={`${r.network}:${r.asset}`}
                        type="button"
                        className={`pv-rail-btn${x402Rail?.asset === r.asset && x402Rail?.network === r.network ? " is-active" : ""}`}
                        onClick={() => setX402Rail(r)}
                        disabled={loading}
                      >
                        <span className="pv-rail-name">{r.label}</span>
                        <span className="pv-rail-amt">
                          {r.amountDisplay} · {formatUsdCents(r.usdCents)}
                        </span>
                        {isCheapest && <span className="pv-rail-tag">cheapest</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                className="vs-btn vs-btn-primary"
                onClick={payX402Edit}
                disabled={loading || !x402Rail || unknownToX402.length > 0}
                style={{ width: "100%", justifyContent: "center" }}
              >
                <IconBolt size={16} />
                {loading ? "Paying…" : `Pay ${x402Rail ? x402Rail.amountDisplay : ""} & generate draft`}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="vb-x402-box" aria-live="polite">
          <p className="vb-x402-status">
            🔒 AI edits cost a small fee each, paid from your wallet. Connect your wallet to
            unlock them — that&apos;s also what makes this blockpage yours.
          </p>
          <SignInButton />
        </div>
      )}
      {x402Note && (
        <p className={`vb-x402-status is-${x402Note.kind}`}>
          {x402Note.kind === "err" ? "❌ " : x402Note.kind === "ok" ? "✅ " : "ℹ️ "}
          {x402Note.text}
        </p>
      )}
      {payMode === "x402" ? (
        <button
          type="button"
          className="vb-quiet-link"
          onClick={() => setPayMode("byok")}
          disabled={loading}
        >
          Advanced: use your own AI key instead
        </button>
      ) : (
        <button
          type="button"
          className="vb-quiet-link"
          onClick={() => setPayMode("x402")}
          disabled={loading || !x402Url}
          title={x402Url ? "Pay per edit from your wallet" : "Pay-per-edit is not configured"}
        >
          ← Back to pay-per-edit
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Publish panel                                                     */
/* ---------------------------------------------------------------- */

function PublishPanel({
  page,
  onPageChange,
  initialOwnerType,
  username,
  onUsernameChange,
  availability,
  liaisonAssisted,
  onPublished,
}: {
  page: VoicescapePage;
  onPageChange: (p: VoicescapePage) => void;
  initialOwnerType?: "human" | "agent";
  /** The blockpage name — owned by the builder so step 1 can edit it pre-wallet. */
  username: string;
  onUsernameChange: (v: string) => void;
  /** On-chain availability of the name (shared with the step-1 field). */
  availability: NameAvailability;
  /**
   * True when the canvas holds the liaison's wallet-bound draft. Code
   * assertion (never convention): liaison-assisted pages ALWAYS publish as
   * human pages with a zero operator and empty purpose — the helper is
   * hired help, never a custodian.
   */
  liaisonAssisted?: boolean;
  /** Called once the publish lands (confirmed or tx-sent) — the builder clears its autosave. */
  onPublished?: () => void;
}) {
  const { account, connect, getTxSender } = useWallet();
  // Brand pass PORT-B: the only i18n in this file — the publish-helper line.
  const { t } = useLanguage();
  const { requireSession, session, signIn, signOut, token } = useSession();
  const hcs = useHcsSubmit();
  const [status, setStatus] = useState<{ kind: "info" | "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  // One-tap fix for a stale WalletConnect session on the publish path —
  // same pattern as the tip modals. Set in the publish catch; cleared when
  // a new publish starts.
  const [publishStale, setPublishStale] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const repairConnection = async () => {
    // Capture the adapter BEFORE signOut() clears the session.
    const stored = WALLET_ADAPTERS.find((a) => a.id === (session?.adapterId ?? "hashpack"));
    const adapterId = stored ? stored.id : "hashpack";
    setRepairing(true);
    setPublishStale(false);
    try {
      await repairStaleConnection({ signOut, connect, adapterId });
      setStatus({ kind: "info", text: "Reconnected — tap Publish to try again." });
    } catch (e) {
      setStatus({ kind: "err", text: `Couldn't reconnect — ${friendlyWalletError(e)}` });
    } finally {
      setRepairing(false);
    }
  };
  // Builder-simplify (2026-09-28): staged publish progress for the overlay
  // (#4) — pinning -> wallet signature -> on-chain confirmation.
  const [publishStage, setPublishStage] = useState<"pinning" | "wallet" | "confirming" | null>(null);
  // Funnel telemetry guard: "publish_started" fires once per mount, consumed
  // inside publish() below. Declared here (before publish) so TS resolves it.
  const publishStartedFired = useRef(false);
  // Builder-simplify (#5): unconfirmed-path confirmation card — the tx is
  // sent but the name doesn't resolve yet, so give the user a copy-link
  // card instead of a vague status line.
  const [pendingPage, setPendingPage] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  // Phase B: who owns this page — human or agent. Agents MUST disclose an
  // operator wallet + purpose (the registry contract reverts otherwise).
  const [ownerType, setOwnerType] = useState<"human" | "agent">(
    initialOwnerType ?? page.ownerType ?? "human",
  );
  // If the draft deep-link resolves after this panel mounts, sync the owner
  // type from it (useState's initializer only runs once).
  useEffect(() => {
    if (initialOwnerType) setOwnerType(initialOwnerType);
  }, [initialOwnerType]);
  const [operatorWallet, setOperatorWallet] = useState("");
  const [operatorName, setOperatorName] = useState("");
  const [operatorUrl, setOperatorUrl] = useState("");
  const [purpose, setPurpose] = useState(page.purpose ?? "");
  const chain = getActiveChain();
  const registry = getRegistryAddress() ?? "(not set)";

  // The name is owned by the builder (name-first: picked before the wallet
  // connects). Publish just trims + validates the shared value.
  const usernameTrimmed = username.trim().toLowerCase();
  const usernameValid = isValidUsername(usernameTrimmed);

  /** Normalize an operator wallet to a 0x address (accepts 0.0.x or 0x). */
  const normalizeOperator = (raw: string): string => {
    const v = raw.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
    if (/^0\.0\.\d+$/.test(v)) {
      // Long-zero account -> EVM address form for the registry's address field.
      return ("0x" + BigInt(v.slice(4)).toString(16).padStart(40, "0")).toLowerCase();
    }
    throw new Error("Operator wallet must be a 0x address or a 0.0.x account id.");
  };

  /**
   * Publish the page. The derived wallet name is always registered (or
   * updated when this wallet already owns it); a custom name, when set,
   * gets its own registry entry pointing at the same content. One tx for
   * the default name, a second only when a custom name is claimed.
   */
  const publish = async () => {
    setStatus(null);
    setTxHash(null);
    setPendingPage(null);
    setLinkCopied(false);
    // Session: use the stored one; if the user dismissed the auto-prompt at
    // connect time, request the signature once here (graceful).
    try {
      requireSession();
    } catch {
      setStatus({ kind: "info", text: "Requesting wallet approval…" });
      try {
        await signIn();
      } catch {
        setStatus({ kind: "err", text: "Approve the wallet request to publish." });
        return;
      }
    }
    if (!account) {
      setStatus({ kind: "err", text: "Connect a wallet first." });
      return;
    }
    const target = usernameTrimmed;
    if (!target) {
      setStatus({ kind: "err", text: "Choose a username for your blockpage." });
      return;
    }
    if (!usernameValid) {
      setStatus({ kind: "err", text: "Username must be 3–24 chars: lowercase letters, numbers, hyphens." });
      return;
    }
    if (availability === "taken") {
      setStatus({ kind: "err", text: "That name is taken — pick another one." });
      return;
    }
    // Validate agent disclosure BEFORE pinning/paying anything.
    let operator = ZERO_ADDRESS;
    let purposeText = "";
    if (ownerType === "agent") {
      try {
        operator = normalizeOperator(operatorWallet);
      } catch (e) {
        setStatus({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        return;
      }
      purposeText = purpose.trim();
      if (!purposeText) {
        setStatus({ kind: "err", text: "Agent blockpages must disclose a purpose." });
        return;
      }
    }
    // Liaison non-custody assertion: a liaison-assisted publish keeps the
    // server-issued draft typing. Human drafts can never leave as agent
    // pages; agent drafts (disclosed and paid for by the agent wallet
    // itself) keep their operator and purpose. The wallet signs everything —
    // the helper never takes control either way.
    if (liaisonAssisted && initialOwnerType !== "agent") {
      if (ownerType !== "human") {
        setStatus({
          kind: "err",
          text: "Liaison-built pages publish as human blockpages only — the helper can never take control.",
        });
        return;
      }
      operator = ZERO_ADDRESS;
      purposeText = "";
    }
    setBusy(true);
    setPublishStage("pinning");
    setPublishStale(false);
    // Funnel telemetry: a publish was attempted (validation passed, pinning
    // started). Once per mount so retries don't inflate the funnel.
    // Aggregate counter only — never throws, never affects publish.
    if (!publishStartedFired.current) {
      publishStartedFired.current = true;
      recordConversionEvent("publish_started");
      // Internal usage telemetry (founder eyes only).
      recordUsageEvent("builder.publish_attempt");
    }
    try {
      // Stamp the page JSON with the derived username plus the informational
      // owner type / purpose, and sync the operator block (if present) with
      // the registration fields.
      const stamped: VoicescapePage = {
        ...page,
        username: target,
        ownerType,
        purpose: ownerType === "agent" ? purposeText : page.purpose,
        blocks: page.blocks.map((b) =>
          b.type === "operator" && ownerType === "agent"
            ? { ...b, wallet: operator, name: operatorName.trim() || b.name, url: operatorUrl.trim() || b.url }
            : b,
        ),
      };
      if (!isValidPage(stamped)) throw new Error("Page failed schema validation.");
      onPageChange(stamped);
      // 1. Pin page JSON to IPFS (server-side via Pinata)
      setStatus({ kind: "info", text: "Pinning page to IPFS…" });
      const ipfsHash = await pinPageJson(JSON.stringify(stamped));
      // 2. Register or update on-chain with the connected wallet — one tx
      // registers (or updates) the single chosen name; no second entry.
      const sender = await getTxSender();
      const ownerFlag = ownerType === "agent" ? 1 : 0;
      const publishName = async (name: string): Promise<string> => {
        // Check if the name exists (via server API to avoid CORS).
        // KISS: no client-side owner check — the contract enforces ownership.
        // If you don't own it, the transaction reverts.
        let exists = false;
        try {
          const res = await fetchWithTimeout(`/api/resolve?username=${encodeURIComponent(name)}`, 10_000, {
            cache: "no-store",
          });
          exists = res.ok;
        } catch {
          exists = false;
        }
        if (exists) {
          setStatus({ kind: "info", text: `Updating /${name} on-chain…` });
          walletStepStarted = true;
          return updatePage(name, ipfsHash, sender);
        }
        setStatus({ kind: "info", text: `Registering /${name} on-chain…` });
        walletStepStarted = true;
        return registerPage(name, ipfsHash, ownerFlag, operator, purposeText, sender);
      };
      // HashPack sometimes goes silent (stale WalletConnect session) — the
      // prompt never appears. The wallet layer times out after 30s with a
      // reconnect message. Reassure after 15s so users don't abandon the page.
      // The wallet wording only applies once the wallet step actually started:
      // during pinning/resolving no wallet prompt exists yet, so claiming
      // "already approved" would be misleading.
      let walletStepStarted = false;
      const waitingNote = setTimeout(() => {
        setStatus({
          kind: "info",
          text: walletStepStarted
            ? "Still working — if you already approved in your wallet, the network is confirming. If no prompt appeared, your wallet connection may be stale."
            : "Still working — please keep this page open.",
        });
      }, 15000);
      let hash: string;
      try {
        // Wallet step starts here: the prompt fires inside publishName.
        setPublishStage("wallet");
        hash = await publishName(target);
      } finally {
        clearTimeout(waitingNote);
      }
      setTxHash(hash);
      setVanityName(account, target);
      // KISS: verify the name actually resolves on-chain before redirecting.
      // A wallet "success" + blind redirect is what produced the 404s.
      setPublishStage("confirming");
      setStatus({ kind: "info", text: "Confirming on-chain… (waiting for the network)" });
      let confirmed = false;
      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetchWithTimeout(
            `/api/resolve?username=${encodeURIComponent(target)}`,
            10_000,
            { cache: "no-store" },
          );
          if (res.ok) {
            const data = (await res.json()) as { ipfsHash?: string };
            if (data.ipfsHash === ipfsHash) {
              confirmed = true;
              break;
            }
          }
        } catch {
          // try again
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      setStatus({ kind: "ok", text: "Published!" });
      // Funnel telemetry: a blockpage was published. Aggregate counter
      // only — recordConversionEvent never throws and never affects publish.
      recordConversionEvent("page_published");
      // Internal usage telemetry (founder eyes only).
      recordUsageEvent("builder.publish_success");
      // Liaison loop-close: if this page came from Danny's draft, confirm
      // the publish with the server so the draft is deleted (the liaison
      // keeps no copy) and the completion is recorded. Best-effort — the
      // page is already live; a missed confirm just leaves the draft to
      // expire via TTL.
      if (liaisonAssisted) {
        try {
          const t = token();
          if (t) {
            const cr = await fetchWithTimeout("/api/liaison/publish-confirm", 10_000, {
              method: "POST",
              headers: { "content-type": "application/json", "x-vs-session": t },
              body: JSON.stringify({ username: target, txHash: hash }),
            });
            // Durable congratulations (browser lane): the server's
            // celebration flag can be lost before the user returns (the
            // server KV is still the ephemeral in-memory fallback), so
            // keep a same-browser backup. The Danny panel shows it once
            // and clears it.
            if (cr.ok) {
              const { stashBrowserCelebration } = await import(
                "@/lib/liaison-celebrate"
              );
              stashBrowserCelebration(target, account ?? "");
            }
          }
        } catch {
          /* draft cleanup is best-effort */
        }
      }
      // Mark onboarding complete — the user has a page now, so the guided
      // onboarding will never show again for this browser.
      markPublished(target);
      // The work is live — drop the local autosave so a later visit starts
      // fresh instead of resurrecting the just-published draft.
      clearBuilderAutosave();
      onPublished?.();
      // One-time congrats card on Buddy's page (/forge): stash the claimed
      // username now that publish has landed on-chain. Best-effort — never
      // blocks publish.
      stashClaimCongrats(target, account ?? "");
      // Record a referral if the user arrived via ?ref= (captured into
      // localStorage by RootProviders). Best-effort — never blocks publish.
      // The new user signs the referral via their wallet (transparent on-chain).
      try {
        const referrer = localStorage.getItem("vs_referral");
        if (referrer && referrer !== target.toLowerCase()) {
          // Tell the user about the second signature prompt before it fires —
          // otherwise "Published!" + an unexplained wallet popup reads as suspicious.
          setStatus({ kind: "info", text: "Published! Recording your referral — one more signature in your wallet…" });
          const hcsTxId = await hcs.submit("forum", {
            v: 1,
            kind: "referral",
            ts: new Date().toISOString(),
            author: target.toLowerCase(),
            referrer: referrer.toLowerCase(),
            referred: target.toLowerCase(),
          });
          if (hcsTxId) {
            await postJson("/api/townhall/referrals", {
              referredUsername: target,
              referrer,
              hcsTxId,
            });
          }
          localStorage.removeItem("vs_referral");
          setStatus({ kind: "ok", text: "Published!" });
        }
      } catch {
        /* referral is best-effort; the page is already published */
        setStatus({ kind: "ok", text: "Published!" });
      }
      if (confirmed) {
        // Redirect to the live page only once it provably resolves. Stash a
        // one-time flag so the page can show the "it's live — share it" card.
        try {
          sessionStorage.setItem("vs-just-published", target);
        } catch {
          /* ignore */
        }
        window.location.href = `/${target}`;
      } else {
        // Don't send the user to a 404 — confirmation card (#5) with a
        // copy-link next action instead of a vague status line.
        setPendingPage(target);
        setStatus({
          kind: "ok",
          text: `Transaction sent (${hash.slice(0, 10)}…).`,
        });
      }
    } catch (e) {
      // Report the reason (not just the count) so the founder dashboard can
      // show WHY publishes fail; plain-words copy for the phone user.
      reportError(e, "builder-publish", { action: "publish", walletState: account ? "connected" : "disconnected" });
      recordConversionEvent("publish_failed");
      // Internal usage telemetry (founder eyes only): why publishes fail.
      recordUsageEvent("builder.publish_failed", { detail: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
      const stale = isStaleConnectionError(e instanceof Error ? e.message : String(e));
      setPublishStale(stale);
      setStatus({ kind: "err", text: `Publish failed: ${friendlyWalletError(e)}` });
    } finally {
      setBusy(false);
      setPublishStage(null);
    }
  };

  return (
    <div className="vb-pub vs-card">
      {/* Builder-simplify (#4): staged progress overlay so the pin → wallet
          → confirm sequence never looks like a dead screen. */}
      {busy && publishStage && (
        <div className="vb-publish-overlay" role="alert" aria-live="assertive">
          <div className="vb-publish-overlay-card">
            <div className="vb-spinner" aria-hidden="true" />
            <div className="vb-publish-overlay-title">
              {publishStage === "pinning"
                ? "Saving your page…"
                : publishStage === "wallet"
                  ? "Approve in your wallet…"
                  : "Confirming on-chain…"}
            </div>
            <p className="vb-publish-overlay-sub">
              {publishStage === "pinning"
                ? "Storing your blockpage on IPFS — keep this tab open."
                : publishStage === "wallet"
                  ? "Check your wallet app and approve the transaction."
                  : "Waiting for Hedera to confirm — usually under a minute."}
            </p>
          </div>
        </div>
      )}
      <div className="vb-pub-head">
        <span className="vb-pub-icon">
          <IconBolt size={17} />
        </span>
        Publish
      </div>

      <UsernameField
        username={username}
        onChange={onUsernameChange}
        account={account}
        availability={availability}
        label="Your blockpage URL"
        hint="Your wallet is your identity — no sign-up needed. The name is yours when you publish."
      />
      {account && (
        <HashpackProfileImport
          account={account}
          onUseName={(name) => onUsernameChange(name)}
          onUseDisplayName={(displayName) => {
            onPageChange({
              ...page,
              blocks: page.blocks.map((b) =>
                b.type === "hero" ? { ...b, title: displayName } : b,
              ),
            });
          }}
        />
      )}

      {/* Human is the default for everyone; the agent path (with its
          on-chain disclosure requirements) sits behind a quiet toggle so
          humans never have to parse agent compliance copy. */}
      <span className="vs-label">Page owner</span>
      {ownerType === "human" ? (
        <div style={{ marginBottom: 4 }}>
          <span className="vs-chip">🧑 Human page</span>
          {!liaisonAssisted && (
            <>
              {" "}
              <button
                type="button"
                className="vb-quiet-link"
                onClick={() => setOwnerType("agent")}
              >
                Making this for an AI agent? Add disclosure →
              </button>
            </>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 4 }}>
          <span className="vs-chip">🤖 Agent page</span>{" "}
          <button type="button" className="vb-quiet-link" onClick={() => setOwnerType("human")}>
            ← back to human
          </button>
        </div>
      )}

      {ownerType === "agent" && (
        <div className="vb-agent-fields">
          <label className="vb-field">
            <span className="vs-label">Operator wallet *</span>
            <input
              className="vs-input vs-mono"
              value={operatorWallet}
              onChange={(e) => setOperatorWallet(e.target.value)}
              placeholder="0x… or 0.0.x — who is responsible for this agent"
            />
          </label>
          <label className="vb-field">
            <span className="vs-label">Purpose *</span>
            <textarea
              className="vs-input"
              rows={2}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="What is this agent for? (shown on the page + stored on-chain)"
            />
          </label>
          <div className="vb-row">
            <label className="vb-field" style={{ flex: 1 }}>
              <span className="vs-label">Operator name</span>
              <input
                className="vs-input"
                value={operatorName}
                onChange={(e) => setOperatorName(e.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="vb-field" style={{ flex: 1 }}>
              <span className="vs-label">Operator URL</span>
              <input
                className="vs-input"
                value={operatorUrl}
                onChange={(e) => setOperatorUrl(e.target.value)}
                placeholder="https://…"
              />
            </label>
          </div>
          <p className="vb-agent-hint">
            🤖 Agent pages always render with the loud AGENT PAGE banner and this operator disclosure —
            read from the on-chain registry, so visitors can never mistake it for a human&apos;s page.
          </p>
        </div>
      )}

      <div className="vb-pub-meta">
        <span className="vs-chip">
          <IconBolt size={14} /> {chain.label}
        </span>
        <span className="vs-mono vb-registry" title={registry}>
          Registry {truncMiddle(registry)}
        </span>
      </div>

      <WalletConnect />
      {!account && (
        <div className="vb-info-hint" style={{ marginTop: 8 }}>
          New to crypto? In HashPack you can create an account with just an email — no seed
          phrase to write down — then come back and publish.
        </div>
      )}

      <div className="vb-pub-actions">
        <p className="vb-info-hint" style={{ marginBottom: 8 }}>
          Publishing costs you nothing but the Hedera network fee — it registers <span className="vs-mono">/{usernameTrimmed || "your-name"}</span> on
          Hedera. Your wallet will ask you to approve one transaction; only the tiny Hedera network fee
          (a few cents of HBAR) applies, nothing else moves. (Arrived via a referral link? One more
          signature may follow for the referral record.)
        </p>
        {!account ? (
          // No dead gray button: without a wallet the action is connecting,
          // so say so and open the picker on tap.
          <button
            type="button"
            className="vs-btn vs-btn-primary"
            onClick={() => requestWalletConnectUI()}
          >
            <IconBolt size={16} /> Connect wallet to publish
          </button>
        ) : (
          <button
            type="button"
            className="vs-btn vs-btn-primary"
            onClick={() => publish()}
            disabled={busy || !usernameValid || availability === "taken"}
          >
            {busy ? "Publishing…" : (<><IconBolt size={16} /> Publish page</>)}
          </button>
        )}
      </div>

      {/* Brand pass PORT-B: plain-words publish promise from the approved mock. */}
      <p className="vb-pub-helper">{t("builder.publishHelper")}</p>

      {status && (
        <div className={`vb-status is-${status.kind}`}>
          {status.text}
          {status.kind === "err" && publishStale && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={repairConnection} disabled={repairing}>
                {repairing ? "Repairing…" : "🔧 Repair connection"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Builder-simplify (#5): post-publish confirmation card for the
          unconfirmed path — big copy-link next action, no dead end. */}
      {pendingPage && (
        <div className="vb-published-card" role="status">
          <p className="vb-published-card-title">🎉 Your page is on its way!</p>
          <p className="vb-published-card-sub">
            It will appear at <span className="vs-mono">/{pendingPage}</span> once
            the network confirms — usually under a minute.
          </p>
          <div className="vb-published-card-actions">
            <button
              type="button"
              className="vs-btn vs-btn-primary"
              onClick={async () => {
                const url = `${window.location.origin}/${pendingPage}`;
                try {
                  await navigator.clipboard.writeText(url);
                } catch {
                  // Clipboard unavailable (older webviews) — select fallback.
                  const ta = document.createElement("textarea");
                  ta.value = url;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand("copy");
                  document.body.removeChild(ta);
                }
                setLinkCopied(true);
                setTimeout(() => setLinkCopied(false), 2500);
              }}
            >
              {linkCopied ? "✅ Copied!" : "🔗 Copy link"}
            </button>
            <a className="vs-btn vs-btn-ghost" href={`/${pendingPage}`}>
              View page →
            </a>
          </div>
        </div>
      )}

      {txHash && (
        <div className="vb-tx">
          <span className="vs-label">Transaction</span>
          <a
            className="vs-mono vb-tx-link"
            href={`${chain.blockExplorer}/transaction/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {truncMiddle(txHash, 10, 8)} <IconExternal size={14} />
          </a>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Builder page                                                      */
/* ---------------------------------------------------------------- */

const TABS = [
  // Round-2 simplify (2026-09-28): numbered so a first-timer sees the order
  // — design, then AI polish, then publish.
  { id: "customize", label: "1 · Customize", icon: <IconGrid size={16} /> },
  { id: "ai", label: "2 · AI edit", icon: <IconSpark size={16} /> },
  { id: "publish", label: "3 · Publish", icon: <IconBolt size={16} /> },
] as const;

type TabId = (typeof TABS)[number]["id"];

function BuilderInner() {
  const chain = getActiveChain();
  const { account } = useWallet();
  // Brand pass PORT-B: the only i18n in this component — the header chrome.
  const { t } = useLanguage();
  // No wallet session required to design: preview mode lets anyone build and
  // preview. The publish flow asks for the wallet signature when it matters.
  const { isAuthenticated, token } = useSession();
  const [templateId, setTemplateId] = useState<string>(
    () => readBuilderAutosave()?.templateId ?? TEMPLATES[0].id,
  );
  const [page, setPage] = useState<VoicescapePage>(() => {
    const saved = readBuilderAutosave()?.page;
    return saved
      ? (JSON.parse(JSON.stringify(saved)) as VoicescapePage)
      : (JSON.parse(JSON.stringify(TEMPLATES[0].page)) as VoicescapePage);
  });
  const [addType, setAddType] = useState<BlockType>("bio");
  const [tab, setTab] = useState<TabId>("customize");

  // Internal usage telemetry (founder eyes only): when the user reaches
  // the Publish tab, snapshot the draft page so the founder dashboard can
  // render exactly what their preview looked like. Anonymous — no wallet,
  // IP, or username attached. Once per visit to the tab.
  const previewSentRef = useRef(false);
  useEffect(() => {
    if (tab !== "publish") {
      previewSentRef.current = false;
      return;
    }
    if (previewSentRef.current) return;
    previewSentRef.current = true;
    // Privacy: the snapshot must stay anonymous per the comment above —
    // strip the username before sending. The dashboard renders the design;
    // the chosen name isn't needed for that.
    const { username: _anonymous, ...previewPage } = page;
    recordUsageEvent("builder.preview", undefined, previewPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab ]);
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);

  // Name-first claim (2026-09-28): the blockpage name is picked in step 1,
  // before any wallet connects. The wallet-derived name (or a remembered
  // vanity name) only auto-fills while the visitor hasn't typed their own —
  // connecting a wallet never clobbers a chosen name.
  const [username, setUsernameRaw] = useState(() => readBuilderAutosave()?.username ?? "");
  const nameTouchedRef = useRef(false);
  // A username restored from autosave counts as user-chosen — the wallet
  // auto-fill must never clobber it.
  useEffect(() => {
    if (username) nameTouchedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B5: debounced autosave — a killed tab never loses canvas work.
  // Local-only, never publishes. Stopped + cleared on successful publish.
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autosaveStopped = useRef(false);
  useEffect(() => {
    if (autosaveStopped.current) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      try {
        const payload: BuilderAutosave = { v: 1, savedAt: Date.now(), templateId, username, page };
        localStorage.setItem(BUILDER_AUTOSAVE_KEY, JSON.stringify(payload));
        setDraftSavedAt(Date.now());
      } catch {
        /* storage unavailable — builder works, just no autosave */
      }
    }, 1000);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [page, templateId, username]);
  const setUsername = useCallback((v: string) => {
    nameTouchedRef.current = true;
    setUsernameRaw(v);
  }, []);
  const usernameTrimmed = username.trim().toLowerCase();
  const usernameValid = isValidUsername(usernameTrimmed);
  const nameAvailability = useUsernameAvailability(usernameTrimmed, account);

  // Human-first claim flow (Brandon 2026-09-27): no-wallet visitors get a
  // 3-step tutorial; the wallet connect is framed as "make it yours".
  const TUTORIAL_DISMISS_KEY = "vs-builder-tutorial-dismissed";
  const [tutorialDismissed, setTutorialDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TUTORIAL_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  // "It's yours now" flash: fires once when an anonymous builder visitor
  // completes the wallet sign-in (the claim moment).
  const [claimedFlash, setClaimedFlash] = useState(false);
  // Builder-simplify (2026-09-28, Brandon: "Do all"): slim "have Buddy build
  // it" banner under the header — 1 HBAR, human reviews before publish.
  // Dismissable; the choice persists per browser.
  const BUDDY_BANNER_DISMISS_KEY = "vs-buddy-banner-dismissed";
  const [buddyBannerDismissed, setBuddyBannerDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BUDDY_BANNER_DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const wasAuthenticated = useRef(isAuthenticated);
  useEffect(() => {
    if (isAuthenticated && !wasAuthenticated.current) {
      setClaimedFlash(true);
      const t = setTimeout(() => setClaimedFlash(false), 9000);
      wasAuthenticated.current = true;
      return () => clearTimeout(t);
    }
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated]);

  // Funnel telemetry: the builder was opened. Once per mount — aggregate
  // counter only, never throws, never blocks the builder.
  const builderOpenedFired = useRef(false);
  useEffect(() => {
    if (builderOpenedFired.current) return;
    builderOpenedFired.current = true;
    recordConversionEvent("builder_opened");
  }, []);

  // Liaison slice-1: the wallet-bound premade blockpage Danny built for this
  // user. Fetched with their session — invisible to every other wallet.
  const [liaisonDraftMeta, setLiaisonDraftMeta] = useState<{
    draftId: string;
    usernameHint: string | null;
    templateId: string;
  } | null>(null);
  const [liaisonDraftId, setLiaisonDraftId] = useState<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated) {
      setLiaisonDraftMeta(null);
      return;
    }
    const t = token();
    if (!t) return;
    let live = true;
    fetchWithTimeout("/api/liaison/draft", 10_000, {
      headers: { "x-vs-session": t },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const d = j?.draft;
        if (live && d && typeof d.draftId === "string") {
          setLiaisonDraftMeta({
            draftId: d.draftId,
            usernameHint: typeof d.usernameHint === "string" ? d.usernameHint : null,
            templateId: typeof d.templateId === "string" ? d.templateId : "",
          });
        }
      })
      .catch(() => {
        /* No draft (or offline) — the "Made for you" card simply stays hidden. */
      });
    return () => {
      live = false;
    };
  }, [isAuthenticated, token]);

  /** Load the liaison draft into the canvas. The page becomes
      liaison-assisted: PublishPanel keeps the server-issued draft typing
      (human drafts publish as human pages only). */
  const pickLiaisonDraft = async () => {
    const t = token();
    if (!t) return;
    try {
      const res = await fetchWithTimeout("/api/liaison/draft", 10_000, {
        headers: { "x-vs-session": t },
        cache: "no-store",
      });
      if (!res.ok) return;
      const j = await res.json();
      const d = j?.draft;
      if (!d?.pageJson || !isValidPage(d.pageJson)) return;
      // The server issues the draft's typing. Human drafts stay human
      // (belt and suspenders client-side); agent drafts keep their
      // operator disclosure.
      const fresh = JSON.parse(JSON.stringify(d.pageJson)) as VoicescapePage;
      const draftIsAgent = fresh.ownerType === "agent";
      if (!draftIsAgent) fresh.ownerType = "human";
      const tmpl = TEMPLATES.find((x) => x.id === d.templateId);
      if (tmpl) setTemplateId(tmpl.id);
      setLiaisonDraftId(typeof d.draftId === "string" ? d.draftId : "liaison");
      setDraftOwnerType(draftIsAgent ? "agent" : "human");
      if (typeof d.usernameHint === "string" && d.usernameHint) {
        setDraftVanity(d.usernameHint);
      }
      setAiDraft(null);
      setPage(fresh);
      setTab("customize");
    } catch {
      /* keep the current canvas on failure */
    }
  };

  const template: Template = useMemo(
    () => TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0],
    [templateId],
  );

  // Any manual edit invalidates a pending AI draft so the preview never lies.
  // Funnel telemetry: the first manual edit per mount — "they didn't just
  // look, they built something." Aggregate counter only, never throws.
  const builderEditedFired = useRef(false);
  const editPage = (next: VoicescapePage | ((p: VoicescapePage) => VoicescapePage)) => {
    if (!builderEditedFired.current) {
      builderEditedFired.current = true;
      recordConversionEvent("builder_edited");
    }
    setAiDraft(null);
    setPage(next);
  };

  const pickTemplate = (t: Template) => {
    setTemplateId(t.id);
    // A different template means the canvas is no longer the liaison's
    // draft — drop the liaison-assisted publish assertion.
    setLiaisonDraftId(null);
    // Deep-clone so edits don't mutate the template definition.
    editPage(JSON.parse(JSON.stringify(t.page)) as VoicescapePage);
  };

  // Buddy draft: if the visitor tapped "Open in Builder" in the Buddy chat,
  // load their complete Buddy-built page. Consumed once — the draft is
  // cleared from localStorage on read. Runs before the onboarding effect so
  // an explicit Buddy handoff wins over onboarding pre-fill.
  const buddyDraftApplied = useRef(false);
  useEffect(() => {
    const draft = consumeBuddyDraft();
    if (!draft) return;
    buddyDraftApplied.current = true;
    // Deep-clone so edits don't mutate the parsed draft object.
    editPage(JSON.parse(JSON.stringify(draft)) as VoicescapePage);
    setDraftOwnerType("human");
    // Offer the draft's username as the vanity claim in the PublishPanel.
    if (typeof draft.username === "string" && isValidUsername(draft.username)) {
      setDraftVanity(draft.username.toLowerCase());
    }
    // "Publish page" from the chat widget: open the builder on its Publish
    // tab so the visitor signs and publishes through the existing flow.
    if (consumeBuddyPublishIntent()) setTab("publish");
    // Internal usage telemetry (founder eyes only): builder opened.
    recordUsageEvent("builder.open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link: /builder?tab=publish selects the Publish tab (used after a
  // Buddy draft handoff when the widget goes straight to publishing).
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("tab") === "publish") {
        setTab("publish");
      }
    } catch {
      /* URL unavailable — keep the default tab */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Onboarding draft: if the user just completed the guided onboarding,
  // pre-fill the builder with their template + identity fields. Consumed
  // once — the draft is cleared from localStorage on read.
  const [draftOwnerType, setDraftOwnerType] = useState<"human" | "agent" | null>(null);
  // A ?draft= link can also suggest a custom page name (its username), which
  // the PublishPanel offers as the vanity claim.
  const [draftVanity, setDraftVanity] = useState<string | null>(null);
  // ?draft=<name> deep-link: load a pre-built page draft from /drafts/<name>.json.
  const searchParams = useSearchParams();
  const [urlDraft, setUrlDraft] = useState<{ name: string; ok: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (buddyDraftApplied.current) return; // Buddy handoff already won.
    const draft = consumeOnboardDraft();
    if (!draft) return;
    const t = TEMPLATES.find((x) => x.id === draft.templateId);
    if (t) {
      setTemplateId(t.id);
      const fresh = JSON.parse(JSON.stringify(t.page)) as VoicescapePage;
      fresh.blocks = fresh.blocks.map((b) => {
        if (b.type === "hero") {
          return {
            ...b,
            title: draft.displayName || b.title,
            subtitle: draft.heroTitle || b.subtitle,
          };
        }
        if (b.type === "bio" && draft.bio) {
          return { ...b, text: draft.bio };
        }
        return b;
      });
      // Pre-fill username from display name (slugified) if it looks valid.
      const slug = draft.displayName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24);
      if (/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(slug)) {
        fresh.username = slug;
      }
      // Quick-build (2026-09-29): pre-fill the socials block from the
      // onboarding sheet's pasted links (pure helper — see lib/quickbuild).
      const withSocials = applyOnboardSocials(fresh, draft.socials);
      setPage(withSocials);
    }
    setDraftOwnerType(draft.ownerType === 1 ? "agent" : "human");
  }, []);

  // ?draft=<name> deep-link: load a pre-built page draft from /drafts/<name>.json
  // and validate it with isValidPage() before applying. Declared after the
  // onboarding-draft effect so an explicit shared link wins when both exist.
  useEffect(() => {
    const raw = searchParams.get("draft");
    if (raw == null || raw === "") return;
    const name = sanitizeDraftName(raw);
    if (!name) {
      setUrlDraft({ name: raw, ok: false, error: "Invalid draft name." });
      return;
    }
    let live = true;
    fetchWithTimeout(draftFileUrl(name), 15_000)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then((data: unknown) => {
        if (!live) return;
        if (!isValidPage(data)) {
          setUrlDraft({ name, ok: false, error: `Draft "${name}" is not a valid page.` });
          return;
        }
        editPage(JSON.parse(JSON.stringify(data)) as VoicescapePage);
        setDraftOwnerType(data.ownerType === "agent" ? "agent" : "human");
        // A draft can suggest a custom page name via its username — offered
        // as the vanity claim in the PublishPanel (the wallet-derived name
        // is always the default). Brandon's draft carries "0xcreator".
        const draftUsername = (data as VoicescapePage).username;
        if (typeof draftUsername === "string" && isValidUsername(draftUsername)) {
          setDraftVanity(draftUsername.toLowerCase());
        }
        // If the draft names its source template, sync the template picker so
        // it doesn't show a stale selection (tapping a template replaces the
        // whole page, including the draft's pre-filled username).
        const draftTemplateId = (data as { templateId?: unknown }).templateId;
        if (
          typeof draftTemplateId === "string" &&
          TEMPLATES.some((t) => t.id === draftTemplateId)
        ) {
          setTemplateId(draftTemplateId);
        }
        setUrlDraft({ name, ok: true });
      })
      .catch(() => {
        if (live) setUrlDraft({ name, ok: false, error: `Could not load draft "${name}".` });
      });
    return () => {
      live = false;
    };
    // Mount-only: the draft param is read once, like the onboarding draft above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?ownerType=agent deep-link: the "Onboard your agent" CTAs across the
  // agents pages land here. Pre-select the agent storefront template and
  // agent mode in the publish panel so onboarding is one flow, not docs.
  useEffect(() => {
    if (searchParams.get("ownerType") !== "agent") return;
    const t = TEMPLATES.find((x) => x.id === "agent-storefront");
    if (t) {
      setTemplateId(t.id);
      editPage(JSON.parse(JSON.stringify(t.page)) as VoicescapePage);
    }
    setDraftOwnerType("agent");
    // Mount-only: the param is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the wallet's published page for editing: when the connected wallet
  // owns a registered page on-chain and no draft is pending (no ?draft= link,
  // no just-completed onboarding draft), hydrate the editor with the
  // published page JSON from IPFS (via /api/resolve). Republishing then
  // calls updatePage on-chain — never a duplicate registration. Runs once
  // the wallet account is known; fails open (blank template stays editable).
  const [loadedPublished, setLoadedPublished] = useState(false);
  const [publishedUsername, setPublishedUsername] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    if (searchParams.get("draft")) return; // explicit shared link wins
    if (searchParams.get("ownerType") === "agent") return; // agent onboarding wins
    try {
      if (localStorage.getItem(ONBOARD_DRAFT_KEY)) return; // onboarding draft wins
    } catch {
      /* storage unavailable — fall through to the on-chain check */
    }
    let live = true;
    (async () => {
      try {
        const username = await fetchRegisteredUsername(account);
        if (!live || !username) return;
        const res = await fetchWithTimeout(
          `/api/resolve?username=${encodeURIComponent(username)}`,
          10_000,
          { cache: "no-store" },
        );
        if (!live || !res.ok) return;
        const data = (await res.json()) as { ipfsHash?: unknown };
        if (!live || typeof data?.ipfsHash !== "string" || !data.ipfsHash) return;
        const pageJson = JSON.parse(await fetchPageJson(data.ipfsHash)) as unknown;
        if (!live || !isValidPage(pageJson)) return;
        const loaded = JSON.parse(JSON.stringify(pageJson)) as VoicescapePage;
        editPage(loaded);
        setDraftOwnerType(loaded.ownerType === "agent" ? "agent" : "human");
        if (isValidUsername(loaded.username)) {
          setPublishedUsername(loaded.username.toLowerCase());
        }
        setLoadedPublished(true);
      } catch {
        // Fail open: the blank template stays editable.
      }
    })();
    return () => {
      live = false;
    };
    // Runs when the wallet account becomes known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Name auto-fill (name-first, 2026-09-28): draft suggestions (?draft=
  // link, Buddy handoff, or this wallet's already-published name) win until
  // the visitor types their own name; then the remembered vanity name or
  // the wallet-derived name fills in. A typed name is never clobbered.
  useEffect(() => {
    if (nameTouchedRef.current) return;
    if (draftVanity && isValidUsername(draftVanity)) {
      setUsernameRaw(draftVanity);
      return;
    }
    if (publishedUsername && isValidUsername(publishedUsername)) {
      setUsernameRaw(publishedUsername);
      return;
    }
    if (!account) return;
    const stored = getVanityName(account);
    if (stored) {
      setUsernameRaw(stored);
      return;
    }
    const derived = deriveUsername(account) ?? deriveUsernameFromEvm(account);
    if (derived) setUsernameRaw(derived);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, draftVanity, publishedUsername]);

  const updateTheme = (key: keyof VoicescapePage["theme"], value: string) =>
    editPage((p) => ({ ...p, theme: { ...p.theme, [key]: value } }));

  // Apply calls onPageUpdate(pending); Discard drops the draft.
  const applyDraft = () => {
    if (!aiDraft) return;
    const pending = aiDraft.page;
    setAiDraft(null);
    setPage(pending);
  };
  const discardDraft = () => setAiDraft(null);

  return (
    <div className="vb-shell">
      {/* Header */}
      <header className="vb-header">
        <Link href="/" className="vb-logo-link" aria-label="Voicescape home">
          <Logo size={30} withWordmark />
        </Link>
        {draftSavedAt && (
          <span
            className="vs-chip"
            title={`Draft auto-saved ${new Date(draftSavedAt).toLocaleTimeString()} — safe to switch apps; your work is stored in this browser only and never published automatically.`}
          >
            <IconCheck size={14} />
            <span className="vb-draft-chip-full">Draft saved</span>
            <span className="vb-draft-chip-short">Saved</span>
          </span>
        )}
        {urlDraft?.ok && (
          <span
            className="vs-chip vb-draft-chip"
            title={`Pre-built draft "${urlDraft.name}" loaded — review it and publish when ready.`}
          >
            <IconCheck size={14} />
            <span className="vb-draft-chip-full">Draft loaded: {urlDraft.name}</span>
            <span className="vb-draft-chip-short">Draft</span>
          </span>
        )}
        {loadedPublished && (
          <span
            className="vs-chip vb-draft-chip"
            title="Your published page loaded from the network — edit it and republish to update it on-chain."
          >
            <IconCheck size={14} />
            <span className="vb-draft-chip-full">Published page loaded — edit & republish to update</span>
            <span className="vb-draft-chip-short">Published</span>
          </span>
        )}
        {urlDraft && !urlDraft.ok && (
          <span className="vs-chip vb-draft-chip is-error" title={urlDraft.error}>
            <IconClose size={14} />
            <span className="vb-draft-chip-full">{urlDraft.error}</span>
            <span className="vb-draft-chip-short">Draft error</span>
          </span>
        )}
        <div className="vb-header-spacer" />
        <span className="vs-chip">
          <IconBolt size={14} /> {chain.label}
        </span>
      </header>

      {/* Brand pass PORT-B: the mock's header chrome (eyebrow + title +
          lede) replaces the old "Blockpage Builder" toolbar title. It sits
          below the sticky toolbar so the 64px sticky offsets stay exact. */}
      <div className="vb-brand">
        <span className="vs-eyebrow">{t("builder.brandEyebrow")}</span>
        <h1 className="vb-brand-title">{t("builder.brandTitle")}</h1>
        <p className="vb-brand-lede">{t("builder.brandLede")}</p>
      </div>

      {/* Builder-simplify (2026-09-28): don't want to DIY? Buddy builds the
          whole page for 1 HBAR — the human reviews before anything publishes.
          Opens the Buddy chat widget (tap "Build with me" there). */}
      {!buddyBannerDismissed && (
        <div className="vb-buddy-banner" role="note" aria-label="Have Buddy build it">
          <span className="vb-buddy-banner-icon" aria-hidden="true">🦎</span>
          <p className="vb-buddy-banner-text">
            <strong>Don&apos;t want to DIY?</strong> Describe your page to Buddy and
            he&apos;ll build it for <strong>1 HBAR</strong> — you review before anything
            publishes.
          </p>
          <button
            type="button"
            className="vs-btn vs-btn-primary vb-buddy-banner-cta"
            onClick={() => window.dispatchEvent(new CustomEvent("vs-open-buddy", { detail: { intent: "build" } }))}
          >
            Ask Buddy to build it
          </button>
          <button
            type="button"
            className="vb-buddy-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => {
              try {
                localStorage.setItem(BUDDY_BANNER_DISMISS_KEY, "1");
              } catch {
                /* storage unavailable — dismiss for this visit only */
              }
              setBuddyBannerDismissed(true);
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Preview mode: anyone can describe + design + preview; the wallet
          connect is the claim ("make it yours"). Tutorials replace the old
          sign-in-first wall. */}
      {!isAuthenticated && !tutorialDismissed && (
        <div className="vb-tutorial" role="note" aria-label="How this works">
          <div className="vb-tutorial-steps">
            <div className="vb-tutorial-step">
              <span className="vb-tutorial-num">1</span>
              <div>
                <strong>Name it</strong>
                <span>Pick your blockpage name — see instantly if it&apos;s available.</span>
              </div>
            </div>
            <div className="vb-tutorial-step">
              <span className="vb-tutorial-num">2</span>
              <div>
                <strong>Preview it</strong>
                <span>See it live. Nothing publishes until you say so.</span>
              </div>
            </div>
            <div className="vb-tutorial-step">
              <span className="vb-tutorial-num">3</span>
              <div>
                <strong>Make it yours</strong>
                <span>Connect your wallet to claim it, then publish.</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="vb-quiet-link"
            onClick={() => {
              try {
                localStorage.setItem(TUTORIAL_DISMISS_KEY, "1");
              } catch {
                /* storage unavailable — dismiss for this visit only */
              }
              setTutorialDismissed(true);
            }}
          >
            Got it
          </button>
        </div>
      )}
      {!isAuthenticated && (
        <div className="vb-preview-banner" role="note">
          <div className="vb-preview-banner-text">
            <strong>Preview mode — this blockpage isn&apos;t yours yet.</strong>{" "}
            <span>Design it freely. Connect your wallet to make it yours, then publish when ready. New to crypto?{" "}
              <a href="/new-to-web3" style={{ color: "var(--vs-accent)", textDecoration: "underline" }}>
                Start here →
              </a>
            </span>
          </div>
          <SignInButton />
        </div>
      )}
      {claimedFlash && (
        <div className="vb-claimed-note" role="status">
          <div className="vb-preview-banner-text">
            <strong>✅ It&apos;s yours now.</strong>{" "}
            <span>This blockpage is claimed to your wallet — publish when you&apos;re ready.</span>
          </div>
          <button type="button" className="vb-quiet-link" onClick={() => setClaimedFlash(false)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="vb-main">
        {/* Left: controls */}
        <div className="vb-controls">
          <TemplatePicker
            activeId={templateId}
            onPick={pickTemplate}
            account={account}
            liaisonDraft={liaisonDraftMeta}
            onPickLiaisonDraft={pickLiaisonDraft}
          />

          <div className="vb-tabs" role="tablist" aria-label="Builder panels">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`vb-tab${tab === t.id ? " is-active" : ""}`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>

          {tab === "customize" && (
            <>
              {/* Name-first (2026-09-28): the blockpage name is picked here in
                  step 1 — no wallet needed. Same shared state as publish. */}
              <UsernameField
                username={username}
                onChange={setUsername}
                account={account}
                availability={nameAvailability}
                label="Your blockpage name"
                hint="Pick it now — claim it on-chain when you publish. No wallet needed yet."
              />
              <ChecklistCard
                nameDone={usernameValid && nameAvailability !== "taken"}
                walletDone={!!account}
                publishedDone={!!publishedUsername}
              />

              <div>
                <div className="vb-panel-title">Blocks</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {page.blocks.map((block, i) => (
                    <BlockEditor
                      key={i}
                      block={block}
                      index={i}
                      onChange={(next) => editPage((p) => ({ ...p, blocks: setBlock(p.blocks, i, next) }))}
                      onRemove={() =>
                        editPage((p) => ({
                          ...p,
                          // Drop the profile-song ref if its music block is removed.
                          profileSong:
                            p.profileSong && p.profileSong.blockIndex === i
                              ? undefined
                              : p.profileSong &&
                                  p.profileSong.blockIndex > i
                                ? { ...p.profileSong, blockIndex: p.profileSong.blockIndex - 1 }
                                : p.profileSong,
                          blocks: p.blocks.filter((_, j) => j !== i),
                        }))
                      }
                      profileSong={page.profileSong}
                      onProfileSongChange={(ref) =>
                        editPage((p) => ({ ...p, profileSong: ref }))
                      }
                    />
                  ))}
                </div>
                <div className="vb-add-row">
                  <select
                    className="vs-input"
                    value={addType}
                    onChange={(e) => setAddType(e.target.value as BlockType)}
                    aria-label="Block type to add"
                  >
                    {PICKER_BLOCK_TYPES.map((bt) => (
                      <option key={bt} value={bt}>
                        {PICKER_LABELS[bt] ?? bt}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="vs-btn vs-btn-primary"
                    onClick={() => {
                      editPage((p) => ({ ...p, blocks: [...p.blocks, createDefaultBlock(addType, p.username)] }));
                      // Internal usage telemetry: block added (type only, no content).
                      recordUsageEvent("builder.block_add", { detail: addType });
                    }}
                  >
                    <IconPlus size={16} /> Add block
                  </button>
                </div>
                {addType === "socials" && (
                  <p className="vs-hint" style={{ marginTop: 6 }}>
                    Paste any link — social profiles get their platform icon automatically.
                  </p>
                )}
              </div>

              {/* Quick-build audit (2026-09-29): theme sits below content —
                  first-timers style a page that exists, not a blank canvas. */}
              <ThemeEditor theme={page.theme} onChange={updateTheme} />
            </>
          )}

          {tab === "ai" && (
            <>
              <VibecodeChat
                page={page}
                draft={aiDraft}
                onDraftChange={setAiDraft}
                onApplyDraft={applyDraft}
                onDiscardDraft={discardDraft}
              />
              {/* Quick-build audit (2026-09-29): the "Next: publish" nudge is
                  gone — the numbered tabs (1·Customize 2·AI edit 3·Publish)
                  already do this job. One navigation mechanism. */}
            </>
          )}

          {tab === "publish" && (
            <PublishPanel
              page={page}
              onPageChange={(p) => editPage(p)}
              initialOwnerType={draftOwnerType ?? undefined}
              // Name-first: the shared name state (picked in step 1) flows
              // into publish; the wallet-derived default is applied in the
              // builder's auto-fill effect, not here.
              username={username}
              onUsernameChange={setUsername}
              availability={nameAvailability}
              liaisonAssisted={liaisonDraftId !== null}
              onPublished={() => {
                // Stop the debounced autosave — the work is live.
                autosaveStopped.current = true;
                if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
              }}
            />
          )}
        </div>

        {/* Right: live preview */}
        <div className="vb-preview" id="vb-preview">
          {aiDraft ? (
            <div className="vb-draft-wrap">
              <div className="vb-draft-inner">
                {/* role="status": announce the draft arrival to screen readers — the
                    pane swaps without moving focus, so SR users need the cue. */}
                <div className="vb-draft-bar vs-glass" role="status">
                  <span className="vb-draft-bar-text">
                    <IconSpark size={16} /> Previewing AI changes
                  </span>
                  <div className="vb-draft-bar-actions">
                    <button type="button" className="vs-btn vs-btn-ghost" onClick={discardDraft}>
                      <IconClose size={14} /> Discard
                    </button>
                    <button type="button" className="vs-btn vs-btn-primary" onClick={applyDraft}>
                      <IconCheck size={14} /> Apply
                    </button>
                  </div>
                </div>
                <PageRenderer page={aiDraft.page} preview />
              </div>
            </div>
          ) : (
            <PageRenderer page={page} preview />
          )}
        </div>
      </div>

      {/* Mobile only (≤960px, CSS-gated): the controls stack above the
          preview on phones, so this jump button takes the user straight to
          the live preview instead of editing blind. */}
      <button
        type="button"
        className="vb-preview-jump"
        onClick={() =>
          document.getElementById("vb-preview")?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
        aria-label="Jump to live preview"
      >
        <IconChevronDown size={15} /> See preview
      </button>
    </div>
  );
}

export default function BuilderPage() {
  // No session gate: anyone can open the builder and preview their
  // blockpage. The wallet signature is requested at publish time.
  return (
    <Suspense
      fallback={
        <div className="vb-shell" style={{ padding: 32, color: "var(--vs-muted)" }}>
          Loading builder…
        </div>
      }
    >
      <BuilderInner />
    </Suspense>
  );
}
