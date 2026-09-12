/**
 * Media safety tests — pure functions, no network, no real files.
 * Synthetic byte arrays exercise the magic-byte sniffing.
 */
import { describe, expect, it } from "vitest";
import {
  sniffMediaKind,
  stripJpegExif,
  validateAudioUpload,
  validateImageUpload,
} from "./media-safety";

function u8(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
/** Pad to at least 12 bytes so sniffers don't bail on short input. */
function pad(arr: number[]): Uint8Array {
  while (arr.length < 16) arr.push(0);
  return u8(arr);
}

describe("sniffMediaKind", () => {
  it("detects images by magic bytes", () => {
    expect(sniffMediaKind(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffMediaKind(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffMediaKind(pad(ascii("GIF89a")))).toBe("gif");
    expect(sniffMediaKind(pad(ascii("GIF87a")))).toBe("gif");
    const webp = [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")];
    expect(sniffMediaKind(pad(webp))).toBe("webp");
  });

  it("detects audio by magic bytes", () => {
    expect(sniffMediaKind(pad(ascii("ID3")))).toBe("mp3");
    expect(sniffMediaKind(pad([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3"); // frame sync
    expect(sniffMediaKind(pad(ascii("OggS")))).toBe("ogg");
    const wav = [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")];
    expect(sniffMediaKind(pad(wav))).toBe("wav");
    expect(sniffMediaKind(pad(ascii("fLaC")))).toBe("flac");
    const m4a = [0, 0, 0, 0x20, ...ascii("ftyp"), ...ascii("M4A ")];
    expect(sniffMediaKind(pad(m4a))).toBe("m4a");
  });

  it("returns unknown for executables and garbage", () => {
    expect(sniffMediaKind(pad(ascii("MZ")))).toBe("unknown"); // Windows exe
    expect(sniffMediaKind(pad(ascii("#!/bin/sh")))).toBe("unknown");
    expect(sniffMediaKind(pad([0x7f, 0x45, 0x4c, 0x46]))).toBe("unknown"); // ELF
    expect(sniffMediaKind(u8([]))).toBe("unknown");
  });
});

describe("validateImageUpload", () => {
  const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("accepts a valid PNG with matching MIME", () => {
    const r = validateImageUpload(png, "image/png");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("png");
  });

  it("rejects when declared MIME disagrees with bytes", () => {
    const r = validateImageUpload(png, "image/jpeg");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("does not match");
  });

  it("rejects non-image bytes", () => {
    const mp3 = pad(ascii("ID3"));
    const r = validateImageUpload(mp3, "audio/mpeg");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not a valid image");
  });

  it("rejects disguised executables", () => {
    const exe = pad(ascii("MZ"));
    const r = validateImageUpload(exe, "image/png");
    expect(r.ok).toBe(false);
  });

  it("rejects oversize files", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = validateImageUpload(big, "image/png", 5 * 1024 * 1024);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("too large");
  });

  it("rejects empty files", () => {
    expect(validateImageUpload(u8([]), "image/png").ok).toBe(false);
  });
});

describe("validateAudioUpload", () => {
  it("accepts valid MP3 audio", () => {
    const mp3 = pad(ascii("ID3"));
    const r = validateAudioUpload(mp3, "audio/mpeg");
    expect(r.ok).toBe(true);
    expect(r.kind).toBe("mp3");
  });

  it("accepts common MIME aliases", () => {
    const wav = pad([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]);
    expect(validateAudioUpload(wav, "audio/x-wav").ok).toBe(true);
  });

  it("rejects a disguised executable declaring audio MIME", () => {
    const exe = pad(ascii("MZ"));
    const r = validateAudioUpload(exe, "audio/mpeg");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not valid audio");
  });

  it("rejects images uploaded as audio", () => {
    const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateAudioUpload(png, "audio/mpeg").ok).toBe(false);
  });
});

describe("stripJpegExif", () => {
  /** Build a minimal JPEG: SOI + APP1(Exif) + APP1(XMP) + EOI. */
  function jpegWithExif(): Uint8Array {
    const exifPayload = [...ascii("Exif\0\0"), 1, 2, 3, 4]; // fake EXIF
    const xmpPayload = [...ascii("http://ns.adobe.com/xap/1.0/\0"), 9, 9];
    const seg = (marker: number, payload: number[]) => [
      0xff, marker,
      ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff,
      ...payload,
    ];
    return u8([0xff, 0xd8, ...seg(0xe1, exifPayload), ...seg(0xe1, xmpPayload), 0xff, 0xd9]);
  }

  it("removes the EXIF APP1 segment but keeps XMP and structure", () => {
    const src = jpegWithExif();
    const out = stripJpegExif(src);
    expect(out.length).toBeLessThan(src.length);
    const text = [...out].map((b) => String.fromCharCode(b)).join("");
    expect(text).not.toContain("Exif");
    expect(text).toContain("ns.adobe.com"); // XMP preserved
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8); // SOI intact
    expect(out[out.length - 2]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xd9); // EOI intact
  });

  it("returns input untouched when no EXIF segment exists", () => {
    const plain = u8([0xff, 0xd8, 0xff, 0xd9]);
    expect(stripJpegExif(plain)).toBe(plain);
  });

  it("leaves non-JPEG input alone", () => {
    const png = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(stripJpegExif(png)).toBe(png);
  });
});
