/**
 * Voicescape — media upload safety.
 *
 * Defense-in-depth for user-uploaded files (currently audio via /api/pin;
 * ready for images if an image upload is ever added):
 *
 *  1. Magic-byte sniffing — the declared Content-Type is client-controlled
 *     and cannot be trusted. The actual bytes decide the kind.
 *  2. Size caps — enforced before pinning so one upload can't burn the
 *     Pinata free-tier allowance.
 *  3. EXIF stripping (JPEG) — removes GPS coordinates and other metadata
 *     before content is published to IPFS, where it would be permanent.
 *
 * Automated NSFW classification is intentionally NOT implemented here:
 * every reliable option requires a third-party API key (e.g. Sightengine).
 * When the project is ready for that, the hook point is `screenUpload()` —
 * add the API call there and return { ok: false, reason } on a flag.
 * Until then, uploaded media is type/size/privacy-checked and user reports
 * + moderator hide actions remain the backstop for objectionable content.
 */

export type MediaKind =
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "mp3"
  | "ogg"
  | "wav"
  | "flac"
  | "m4a"
  | "unknown";

export interface UploadScreenResult {
  ok: boolean;
  /** Categorical reason when rejected. Never echoes file content. */
  reason?: string;
  /** The kind detected from magic bytes. */
  kind?: MediaKind;
  /**
   * Privacy-cleaned bytes when ok and cleaning applied (JPEG EXIF strip).
   * Absent when no cleaning was needed.
   */
  cleaned?: Uint8Array;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len && offset + i < bytes.length; i++) {
    s += String.fromCharCode(bytes[offset + i]);
  }
  return s;
}

/**
 * Detect the real media kind from magic bytes. Never trusts the
 * declared Content-Type.
 */
export function sniffMediaKind(bytes: Uint8Array): MediaKind {
  if (!bytes || bytes.length < 12) return "unknown";
  // Images
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (asciiAt(bytes, 0, 6) === "GIF87a" || asciiAt(bytes, 0, 6) === "GIF89a") return "gif";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WEBP") return "webp";
  // Audio
  if (asciiAt(bytes, 0, 3) === "ID3") return "mp3";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3"; // frame sync
  if (asciiAt(bytes, 0, 4) === "OggS") return "ogg";
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 4) === "WAVE") return "wav";
  if (asciiAt(bytes, 0, 4) === "fLaC") return "flac";
  if (asciiAt(bytes, 4, 4) === "ftyp") return "m4a"; // ftyp box at offset 4
  return "unknown";
}

const IMAGE_KINDS: MediaKind[] = ["jpeg", "png", "gif", "webp"];
const AUDIO_KINDS: MediaKind[] = ["mp3", "ogg", "wav", "flac", "m4a"];

const KIND_TO_MIME: Record<MediaKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  unknown: "application/octet-stream",
};

/** Default caps: 5 MB images, 25 MB audio (matches the pin route). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES_SAFETY = 25 * 1024 * 1024;

/**
 * Validate an image upload: real kind must be an image, declared MIME
 * must agree with the sniffed bytes, and size must be within cap.
 */
export function validateImageUpload(
  bytes: Uint8Array,
  declaredMime: string | null | undefined,
  maxBytes = MAX_IMAGE_BYTES,
): UploadScreenResult {
  if (!bytes || bytes.length === 0) return { ok: false, reason: "empty file" };
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `image too large (max ${(maxBytes / 1024 / 1024).toFixed(0)} MB)` };
  }
  const kind = sniffMediaKind(bytes);
  if (!IMAGE_KINDS.includes(kind)) {
    return { ok: false, reason: "file is not a valid image (JPEG, PNG, GIF, or WebP required)" };
  }
  const declared = (declaredMime ?? "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== KIND_TO_MIME[kind]) {
    return { ok: false, reason: "declared file type does not match the actual file content" };
  }
  // Privacy: strip EXIF from JPEGs before they reach permanent storage.
  const cleaned = kind === "jpeg" ? stripJpegExif(bytes) : undefined;
  return { ok: true, kind, ...(cleaned ? { cleaned } : {}) };
}

/**
 * Validate an audio upload: real kind must be audio, declared MIME must
 * agree, size within cap. Used by /api/pin as defense-in-depth on top of
 * its Content-Type string check — a disguised executable can't pass this.
 */
export function validateAudioUpload(
  bytes: Uint8Array,
  declaredMime: string | null | undefined,
  maxBytes = MAX_AUDIO_BYTES_SAFETY,
): UploadScreenResult {
  if (!bytes || bytes.length === 0) return { ok: false, reason: "empty file" };
  if (bytes.length > maxBytes) {
    return { ok: false, reason: `audio too large (max ${(maxBytes / 1024 / 1024).toFixed(0)} MB)` };
  }
  const kind = sniffMediaKind(bytes);
  if (!AUDIO_KINDS.includes(kind)) {
    return { ok: false, reason: "file is not valid audio" };
  }
  const declared = (declaredMime ?? "").split(";")[0].trim().toLowerCase();
  // Accept common aliases: audio/x-wav, audio/x-flac, audio/m4a, audio/aac for m4a container.
  const aliases: Record<MediaKind, string[]> = {
    jpeg: [], png: [], gif: [], webp: [], unknown: [],
    mp3: ["audio/mp3", "audio/x-mp3"],
    ogg: ["audio/vorbis"],
    wav: ["audio/x-wav", "audio/vnd.wave"],
    flac: ["audio/x-flac"],
    m4a: ["audio/m4a", "audio/aac", "audio/x-m4a"],
  };
  if (declared && declared !== KIND_TO_MIME[kind] && !aliases[kind].includes(declared)) {
    return { ok: false, reason: "declared file type does not match the actual file content" };
  }
  return { ok: true, kind };
}

/**
 * Strip the EXIF APP1 segment from a JPEG.
 *
 * JPEG layout: SOI (FFD8), then segments (FF marker + 2-byte BE length
 * including the length bytes), until SOS (FFDA) or EOI (FFD9). APP1
 * (FFE1) segments whose payload starts with "Exif\\0\\0" carry EXIF
 * metadata (GPS, camera, timestamps). They are removed; everything else
 * (including XMP APP1 and ICC APP2) is preserved byte-for-byte.
 *
 * Returns the original bytes untouched when no EXIF segment is found.
 */
export function stripJpegExif(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  let stripped = false;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) break; // not a marker — stop, copy rest
    const marker = bytes[i + 1];
    // Standalone markers with no length field.
    if (marker === 0xd9 || marker === 0xda) {
      // EOI or SOS: copy the marker and everything after verbatim.
      for (let j = i; j < bytes.length; j++) out.push(bytes[j]);
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(0xff, marker);
      i += 2;
      continue;
    }
    if (i + 3 >= bytes.length) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) break; // corrupt — stop
    const payloadStart = i + 4;
    const isExifApp1 =
      marker === 0xe1 &&
      payloadStart + 6 <= bytes.length &&
      bytes[payloadStart] === 0x45 && // 'E'
      bytes[payloadStart + 1] === 0x78 && // 'x'
      bytes[payloadStart + 2] === 0x69 && // 'i'
      bytes[payloadStart + 3] === 0x66 && // 'f'
      bytes[payloadStart + 4] === 0x00 &&
      bytes[payloadStart + 5] === 0x00;
    if (isExifApp1) {
      stripped = true;
      // Skip this segment entirely.
    } else {
      for (let j = i; j < i + 2 + len; j++) out.push(bytes[j]);
    }
    i += 2 + len;
  }
  if (!stripped) return bytes;
  return new Uint8Array(out);
}

/**
 * Composite screen for a future image-upload endpoint.
 * Currently: type + size + EXIF privacy cleaning.
 * NSFW classification hook: wire a moderation API call here when a key
 * is available (see module header). Until then returns ok for clean files.
 */
export function screenUpload(
  bytes: Uint8Array,
  declaredMime: string | null | undefined,
  opts?: { maxBytes?: number },
): UploadScreenResult {
  return validateImageUpload(bytes, declaredMime, opts?.maxBytes ?? MAX_IMAGE_BYTES);
}
