import { describe, expect, it } from "vitest";
import { parseVideoUrl, videoEmbedUrl } from "./video";

describe("parseVideoUrl", () => {
  it("accepts YouTube watch, short, embed and shorts links", () => {
    expect(parseVideoUrl("https://www.youtube.com/watch?v=HjAVZ8fXiIE")).toEqual({
      kind: "youtube",
      id: "HjAVZ8fXiIE",
    });
    expect(parseVideoUrl("https://youtu.be/dFBacyAxgAo")).toEqual({
      kind: "youtube",
      id: "dFBacyAxgAo",
    });
    expect(parseVideoUrl("https://www.youtube-nocookie.com/embed/HjAVZ8fXiIE?rel=0")).toEqual({
      kind: "youtube",
      id: "HjAVZ8fXiIE",
    });
    expect(parseVideoUrl("https://www.youtube.com/shorts/dFBacyAxgAo")).toEqual({
      kind: "youtube",
      id: "dFBacyAxgAo",
    });
  });

  it("accepts the Reel24 Town Hall MP4 (bucket + site, query kept)", () => {
    const bucket =
      "https://storage.googleapis.com/reel24-media/films/voicescape-town-hall-e001.mp4?v=1793632719";
    expect(parseVideoUrl(bucket)).toEqual({ kind: "mp4", url: bucket });
    expect(
      parseVideoUrl("https://thevisualxperience.com/films/voicescape-town-hall-e001.mp4"),
    ).toEqual({
      kind: "mp4",
      url: "https://thevisualxperience.com/films/voicescape-town-hall-e001.mp4",
    });
  });

  it("rejects other hosts, non-mp4 files, and non-URLs", () => {
    // A lookalike bucket path on another host must not pass.
    expect(parseVideoUrl("https://evil.example.com/reel24-media/films/x.mp4")).toBeNull();
    // Reel24 bucket, wrong extension.
    expect(
      parseVideoUrl("https://storage.googleapis.com/reel24-media/films/x.mov"),
    ).toBeNull();
    // Reel24 bucket, wrong prefix.
    expect(parseVideoUrl("https://storage.googleapis.com/other/x.mp4")).toBeNull();
    // Not a video at all.
    expect(parseVideoUrl("https://www.youtube.com/playlist?list=PL123456")).toBeNull();
    expect(parseVideoUrl("javascript:alert(1)")).toBeNull();
    expect(parseVideoUrl("")).toBeNull();
    expect(parseVideoUrl(null)).toBeNull();
    expect(parseVideoUrl(42)).toBeNull();
    // http: MP4s are rejected (mixed content on the https site).
    expect(parseVideoUrl("http://storage.googleapis.com/reel24-media/films/x.mp4")).toBeNull();
  });
});

describe("videoEmbedUrl", () => {
  it("builds a youtube-nocookie embed for YouTube and passes MP4s through", () => {
    expect(videoEmbedUrl({ kind: "youtube", id: "HjAVZ8fXiIE" })).toBe(
      "https://www.youtube-nocookie.com/embed/HjAVZ8fXiIE?rel=0",
    );
    const mp4 = "https://storage.googleapis.com/reel24-media/films/x.mp4?v=1";
    expect(videoEmbedUrl({ kind: "mp4", url: mp4 })).toBe(mp4);
  });
});
