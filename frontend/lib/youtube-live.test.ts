import { describe, expect, it } from "vitest";
import {
  isYouTubeChannelId,
  isYouTubeVideoId,
  parseYouTubeLiveStatus,
} from "./youtube-live";

describe("parseYouTubeLiveStatus", () => {
  it("reports live with the video id when canonical points at a watch URL", () => {
    const html = `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=rFZHOHl-L8A"></head></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: true, videoId: "rFZHOHl-L8A" });
  });

  it("reports offline when canonical points back at the channel page", () => {
    const html = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx/live"></head></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: false, videoId: null });
  });

  it("reports offline when there is no canonical link", () => {
    expect(parseYouTubeLiveStatus("<html><head></head></html>")).toEqual({
      live: false,
      videoId: null,
    });
  });

  it("rejects a malformed video id in the canonical URL", () => {
    const html = `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=too-short"></head></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: false, videoId: null });
  });
});

describe("id validators", () => {
  it("accepts real channel and video ids, rejects junk", () => {
    expect(isYouTubeChannelId("UCSJ4gkVC6NrvII8umztf0Ow")).toBe(true);
    expect(isYouTubeChannelId("UCxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
    expect(isYouTubeChannelId("not-a-channel")).toBe(false);
    expect(isYouTubeChannelId("UCshort")).toBe(false);
    expect(isYouTubeVideoId("rFZHOHl-L8A")).toBe(true);
    expect(isYouTubeVideoId("too-short")).toBe(false);
  });
});
