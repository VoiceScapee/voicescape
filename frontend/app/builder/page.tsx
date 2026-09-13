"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import PageRenderer from "@/components/PageRenderer";
import Logo from "@/components/Logo";
import { VoiceInput } from "@/components/VoiceInput";
import { consumeOnboardDraft, ONBOARD_DRAFT_KEY } from "@/components/Onboarding";
import { markPublished } from "@/components/OnboardingTrigger";
import {
  IconArrowRight,
  IconBolt,
  IconBook,
  IconCheck,
  IconClose,
  IconExternal,
  IconGrid,
  IconLink,
  IconMusic,
  IconPlus,
  IconSpark,
  IconTip,
  IconTrash,
  IconUsers,
} from "@/components/icons";
import {
  BLOCK_TYPES,
  createDefaultBlock,
  isValidPage,
  type Block,
  type BlockType,
  type MusicTrack,
  type ProfileSongRef,
  type VoicescapePage,
} from "@/lib/schema";
import { MUSIC_SOURCE_LABELS, parseMusicUrl } from "@/lib/music";
import { pinAudioFile } from "@/lib/ipfs";
import { TEMPLATES, type Template } from "@/lib/templates";
import { getHederaPairing, useWallet } from "@/lib/wallet";
import { sanitizeDraftName, draftFileUrl } from "@/lib/drafts";
import { WalletConnect } from "@/components/WalletConnect";
import { RequireSession, useSession } from "@/lib/session";
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
import { registerPage, updatePage, ZERO_ADDRESS } from "@/lib/contracts";
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

      {block.type === "tipJar" && (
        <label className="vb-field">
          <span className="vs-label">Tip jar message</span>
          <input
            className="vs-input"
            value={block.message ?? ""}
            placeholder="Tip jar message (optional)"
            onChange={(e) => onChange({ ...block, message: e.target.value })}
          />
        </label>
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

      {block.type === "gallery" && (
        <>
          <span className="vs-label">Images</span>
          {block.images.map((img, i) => (
            <div className="vb-row" key={i}>
              <input
                className="vs-input"
                style={{ flex: 1 }}
                value={img}
                placeholder="Emoji"
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
/* Template picker                                                   */
/* ---------------------------------------------------------------- */

function TemplatePicker({
  activeId,
  onPick,
}: {
  activeId: string;
  onPick: (t: Template) => void;
}) {
  const [category, setCategory] = useState<"business" | "personal">("personal");
  const filtered = TEMPLATES.filter((t) => t.category === category);
  return (
    <div>
      <div className="vb-panel-title">Template</div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: "block", fontSize: 13, marginBottom: 6, color: "var(--vs-muted)" }}>
          Page type
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
      text: "Hey! Describe how you want your page to look and I'll draft a new version — you review it in the preview, then apply or discard.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Two ways to pay for AI edits — both paid by the user, never by the app:
  // "byok" calls Anthropic directly from this browser with the user's own
  // API key; "x402" pays the x402 vibecode endpoint per edit from the
  // wallet. There is no server-paid AI path.
  const x402Url = getX402VibecodeUrl();
  const [payMode, setPayMode] = useState<"byok" | "x402">("byok");
  const [x402Rails, setX402Rails] = useState<X402Rail[] | null>(null);
  const [x402Rail, setX402Rail] = useState<X402Rail | null>(null);
  const [x402Pending, setX402Pending] = useState<string | null>(null);
  const [x402Note, setX402Note] = useState<{ kind: "info" | "err" | "ok"; text: string } | null>(null);

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
    setX402Pending(instruction);
    setLoading(true);
    try {
      const probe = await probeX402(x402Url);
      setX402Rails(probe.rails);
      setX402Rail(probe.rails[0] ?? null);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: "The x402 vibecode service charges per edit. Pick a rail below, then pay — your wallet signs one transfer, the service edits, and you review the draft here." },
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
      const network = activeChain.key === "hedera-mainnet" ? "mainnet" : "testnet";
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
      const data = JSON.parse(text) as { pageJson?: unknown; error?: string; mock?: boolean };
      if (data.error || !isValidPage(data.pageJson)) {
        throw new Error(data.error ?? "The service returned an invalid page.");
      }
      const summary = summarizeChanges(page, data.pageJson);
      onDraftChange({ page: data.pageJson, summary, instruction: x402Pending });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: `Paid edit settled${settleTxId ? ` (tx ${settleTxId.slice(0, 20)}…)` : ""}${
            data.mock ? " — note: the service returned a labeled MOCK edit." : ""
          } Review the draft in the preview pane, then Apply or Discard.`,
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
    setInput("");
    setMessages((m) => [...m, { role: "user", text: instruction }]);
    if (payMode === "x402") {
      await startX402(instruction);
    } else {
      await sendByok(instruction);
    }
  };


  const showSuggestions = messages.length <= 1 && !loading && !draft;

  return (
    <div className="vb-chat vs-card">
      <div className="vb-chat-head">
        <span className="vb-spark">
          <IconSpark size={16} />
        </span>
        Vibecode AI
      </div>

      <div className="vb-paymode" role="group" aria-label="AI edit payment mode">
        <button
          type="button"
          className={`vb-chip-btn${payMode === "byok" ? " is-active" : ""}`}
          onClick={() => setPayMode("byok")}
          disabled={loading}
          title="Use your own Anthropic API key — billed by Anthropic to you"
        >
          <IconSpark size={13} /> My AI key
        </button>
        <button
          type="button"
          className={`vb-chip-btn${payMode === "x402" ? " is-active" : ""}`}
          onClick={() => setPayMode("x402")}
          disabled={loading || !x402Url}
          title={x402Url ? "Pay the x402 vibecode endpoint per edit from your wallet" : "Set NEXT_PUBLIC_X402_VIBECODE_URL to enable pay-per-edit"}
        >
          <IconBolt size={13} /> Pay per edit (x402)
        </button>
      </div>

      {payMode === "byok" && (
        <div className="vb-x402-box" aria-live="polite">
          <p className="vb-x402-status">
            🔑 AI generation uses <strong>your own Anthropic API key</strong> — billed by Anthropic to you.
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
      )}

      {payMode === "x402" && (
        <div className="vb-x402-box" aria-live="polite">
          {unknownToX402.length > 0 && (
            <p className="vb-x402-status is-err">
              ⚠️ This page uses block types the x402 service doesn&apos;t know yet (
              {unknownToX402.join(", ")}) — it would reject the request <em>after</em> you pay.
              Remove them or use My AI key for this edit.
            </p>
          )}
          {x402Rails && x402Pending && (
            <>
              <div className="pv-rail-row" role="group" aria-label="Payment rail">
                {x402Rails.map((r) => (
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
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="vs-btn vs-btn-primary"
                onClick={payX402Edit}
                disabled={loading || !x402Rail || unknownToX402.length > 0}
                style={{ width: "100%", justifyContent: "center" }}
              >
                <IconBolt size={16} />
                {loading ? "Paying…" : `Pay ${x402Rail ? x402Rail.amountDisplay : ""} & edit`}
              </button>
            </>
          )}
          {x402Note && (
            <p className={`vb-x402-status is-${x402Note.kind}`}>
              {x402Note.kind === "err" ? "❌ " : x402Note.kind === "ok" ? "✅ " : "ℹ️ "}
              {x402Note.text}
            </p>
          )}
        </div>
      )}

      <div className="vb-chat-log">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`vb-bubble ${
              m.role === "user" ? "vb-bubble-user" : m.role === "error" ? "vb-bubble-error" : "vb-bubble-assistant"
            }`}
          >
            {m.text}
          </div>
        ))}
        {loading && (
          <div className="vb-dreaming">
            <span className="vb-dreaming-orb" />
            <span className="vb-shimmer-text">dreaming up your page…</span>
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
  initialVanity,
}: {
  page: VoicescapePage;
  onPageChange: (p: VoicescapePage) => void;
  initialOwnerType?: "human" | "agent";
  /** A custom name suggested by a loaded draft (e.g. the ?draft= link). */
  initialVanity?: string | null;
}) {
  const { account, getTxSender } = useWallet();
  const { requireSession, signIn } = useSession();
  const hcs = useHcsSubmit();
  const [status, setStatus] = useState<{ kind: "info" | "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
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
  const registry = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS ?? "(not set)";

  // KISS identity: the wallet address IS the page name. The derived name
  // (user-10424063) is the default; a custom name is an optional claim.
  // Falls back to EVM-derived name when only an EVM address is available.
  const derivedUsername = account
    ? (deriveUsername(account) ?? deriveUsernameFromEvm(account))
    : null;
  // KISS: single editable username. Defaults to the wallet-derived name,
  // user can change it to anything (e.g. 0xcreator). One name, one publish.
  const [username, setUsername] = useState("");
  useEffect(() => {
    if (!account) return;
    if (initialVanity && isValidUsername(initialVanity)) {
      setUsername(initialVanity);
      return;
    }
    const stored = getVanityName(account);
    if (stored) {
      setUsername(stored);
      return;
    }
    if (derivedUsername) setUsername(derivedUsername);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);
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
    // Session: use the stored one; if the user dismissed the auto-prompt at
    // connect time, request the signature once here (graceful).
    try {
      requireSession();
    } catch {
      setStatus({ kind: "info", text: "Requesting wallet signature…" });
      try {
        await signIn();
      } catch {
        setStatus({ kind: "err", text: "Sign the wallet message to publish." });
        return;
      }
    }
    if (!account) {
      setStatus({ kind: "err", text: "Connect a wallet first." });
      return;
    }
    const target = usernameTrimmed;
    if (!target) {
      setStatus({ kind: "err", text: "Choose a username for your page." });
      return;
    }
    if (!usernameValid) {
      setStatus({ kind: "err", text: "Username must be 3–24 chars: lowercase letters, numbers, hyphens." });
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
        setStatus({ kind: "err", text: "Agent pages must disclose a purpose." });
        return;
      }
    }
    setBusy(true);
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
      // 2. Register or update on-chain with the connected wallet. Each name
      // gets one tx; the custom name is a second registry entry pointing at
      // the same content.
      const sender = await getTxSender();
      const ownerFlag = ownerType === "agent" ? 1 : 0;
      const publishName = async (name: string): Promise<string> => {
        // Check if the name exists (via server API to avoid CORS).
        // KISS: no client-side owner check — the contract enforces ownership.
        // If you don't own it, the transaction reverts.
        let exists = false;
        try {
          const res = await fetch(`/api/resolve?username=${encodeURIComponent(name)}`, {
            cache: "no-store",
          });
          exists = res.ok;
        } catch {
          exists = false;
        }
        if (exists) {
          setStatus({ kind: "info", text: `Updating /${name} on-chain…` });
          return updatePage(name, ipfsHash, sender);
        }
        setStatus({ kind: "info", text: `Registering /${name} on-chain…` });
        return registerPage(name, ipfsHash, ownerFlag, operator, purposeText, sender);
      };
      // HashPack sometimes goes silent after the user approves (the tx still
      // lands on-chain; the wallet layer recovers via the mirror node after a
      // 90s timeout). Without a progress hint the UI looks frozen on
      // "Registering…" — reassure after 15s so users don't abandon the page.
      const waitingNote = setTimeout(() => {
        setStatus({
          kind: "info",
          text: "Still working — if you already approved in your wallet, the network is confirming. This can take up to ~90 seconds; please keep this page open.",
        });
      }, 15000);
      let hash: string;
      try {
        hash = await publishName(target);
      } finally {
        clearTimeout(waitingNote);
      }
      setTxHash(hash);
      setVanityName(account, target);
      // KISS: verify the name actually resolves on-chain before redirecting.
      // A wallet "success" + blind redirect is what produced the 404s.
      setStatus({ kind: "info", text: "Confirming on-chain… (waiting for the network)" });
      let confirmed = false;
      for (let i = 0; i < 10; i++) {
        try {
          const res = await fetch(`/api/resolve?username=${encodeURIComponent(target)}`, {
            cache: "no-store",
          });
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
      // Mark onboarding complete — the user has a page now, so the guided
      // onboarding will never show again for this browser.
      markPublished(target);
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
        // Redirect to the live page only once it provably resolves.
        window.location.href = `/${target}`;
      } else {
        // Don't send the user to a 404 — show the tx and a manual link.
        setStatus({
          kind: "info",
          text: `Transaction sent (${hash.slice(0, 10)}…). The page will appear at /${target} once the network confirms it — give it a minute, then tap below.`,
        });
      }
    } catch (e) {
      setStatus({ kind: "err", text: `Publish failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vb-pub vs-card">
      <div className="vb-pub-head">
        <span className="vb-pub-icon">
          <IconBolt size={17} />
        </span>
        Publish
      </div>

      <div className="vb-field">
        <span className="vs-label">Your page URL</span>
        <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
          <span className="vs-mono" style={{ fontSize: 15, color: "var(--vs-muted)" }}>/</span>
          <input
            className="vs-input vs-mono"
            value={username}
            onChange={(e) =>
              setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24))
            }
            placeholder={derivedUsername ?? "connect your wallet…"}
            style={{ fontSize: 15 }}
            aria-label="Page username"
          />
        </div>
        <div className="vb-info-hint">
          Your wallet is your identity — no sign-up needed. Pick any name, like 0xcreator.
        </div>
        {!usernameValid && username.length > 0 && (
          <div className="vb-username-hint">Use 3–24 lowercase letters, numbers, or hyphens.</div>
        )}
      </div>

      <span className="vs-label">Page owner</span>
      <div className="pv-rail-row" role="group" aria-label="Page owner type" style={{ marginBottom: 4 }}>
        <button
          type="button"
          className={`pv-rail-btn${ownerType === "human" ? " is-active" : ""}`}
          onClick={() => setOwnerType("human")}
        >
          <span className="pv-rail-name">🧑 Human</span>
          <span className="pv-rail-amt">a person&apos;s page</span>
        </button>
        <button
          type="button"
          className={`pv-rail-btn${ownerType === "agent" ? " is-active" : ""}`}
          onClick={() => setOwnerType("agent")}
        >
          <span className="pv-rail-name">🤖 Agent</span>
          <span className="pv-rail-amt">AI-operated · disclosure required</span>
        </button>
      </div>

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

      <div className="vb-pub-actions">
        <button
          type="button"
          className="vs-btn vs-btn-primary"
          onClick={() => publish()}
          disabled={busy || !account || !usernameValid}
        >
          {busy ? "Publishing…" : (<><IconBolt size={16} /> Publish page</>)}
        </button>
      </div>

      {status && <div className={`vb-status is-${status.kind}`}>{status.text}</div>}

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
  { id: "customize", label: "Customize", icon: <IconGrid size={16} /> },
  { id: "ai", label: "AI", icon: <IconSpark size={16} /> },
  { id: "publish", label: "Publish", icon: <IconBolt size={16} /> },
] as const;

type TabId = (typeof TABS)[number]["id"];

function BuilderInner() {
  const chain = getActiveChain();
  const { account } = useWallet();
  const [templateId, setTemplateId] = useState<string>(TEMPLATES[0].id);
  const [page, setPage] = useState<VoicescapePage>(() =>
    JSON.parse(JSON.stringify(TEMPLATES[0].page)) as VoicescapePage,
  );
  const [addType, setAddType] = useState<BlockType>("bio");
  const [tab, setTab] = useState<TabId>("customize");
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);

  const template: Template = useMemo(
    () => TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0],
    [templateId],
  );

  // Any manual edit invalidates a pending AI draft so the preview never lies.
  const editPage = (next: VoicescapePage | ((p: VoicescapePage) => VoicescapePage)) => {
    setAiDraft(null);
    setPage(next);
  };

  const pickTemplate = (t: Template) => {
    setTemplateId(t.id);
    // Deep-clone so edits don't mutate the template definition.
    editPage(JSON.parse(JSON.stringify(t.page)) as VoicescapePage);
  };

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
      setPage(fresh);
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
    fetch(draftFileUrl(name))
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
        const res = await fetch(
          `/api/resolve?username=${encodeURIComponent(username)}`,
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
        <span className="vb-header-divider" />
        <h1 className="vb-header-title">Page Builder</h1>
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

      <div className="vb-main">
        {/* Left: controls */}
        <div className="vb-controls">
          <TemplatePicker activeId={templateId} onPick={pickTemplate} />

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
              <ThemeEditor theme={page.theme} onChange={updateTheme} />

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
                    {BLOCK_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="vs-btn vs-btn-primary"
                    onClick={() => editPage((p) => ({ ...p, blocks: [...p.blocks, createDefaultBlock(addType, p.username)] }))}
                  >
                    <IconPlus size={16} /> Add block
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === "ai" && (
            <VibecodeChat
              page={page}
              draft={aiDraft}
              onDraftChange={setAiDraft}
              onApplyDraft={applyDraft}
              onDiscardDraft={discardDraft}
            />
          )}

          {tab === "publish" && (
            <PublishPanel
              page={page}
              onPageChange={(p) => editPage(p)}
              initialOwnerType={draftOwnerType ?? undefined}
              // The wallet's published username (loaded from the network)
              // defaults the name field so republishing updates the page
              // on-chain instead of registering a second one.
              initialVanity={draftVanity ?? publishedUsername}
            />
          )}
        </div>

        {/* Right: live preview */}
        <div className="vb-preview">
          {aiDraft ? (
            <div className="vb-draft-wrap">
              <div className="vb-draft-inner">
                <div className="vb-draft-bar vs-glass">
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
                <PageRenderer page={aiDraft.page} />
              </div>
            </div>
          ) : (
            <PageRenderer page={page} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function BuilderPage() {
  return (
    <RequireSession
      title="Sign in to build your page"
      description="Connect your wallet and sign the sign-in message to open the page builder."
    >
      {/* Suspense boundary required by Next.js for useSearchParams (?draft= deep-link). */}
      <Suspense
        fallback={
          <div className="vb-shell" style={{ padding: 32, color: "var(--vs-muted)" }}>
            Loading builder…
          </div>
        }
      >
        <BuilderInner />
      </Suspense>
    </RequireSession>
  );
}
