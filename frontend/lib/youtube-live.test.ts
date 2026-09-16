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

  it("falls back to embedded watch data when canonical is unusable (degraded variant)", () => {
    // Mirrors the real degraded /live page: canonical href="undefined",
    // "isLive":true exactly once, live video the most-referenced videoId.
    const liveRefs = Array(5).fill(`"videoId":"rFZHOHl-L8A"`).join(",");
    const otherRefs = `"videoId":"JD-kMIpDfnY","videoId":"JD-kMIpDfnY"`;
    const html =
      `<html><head><link rel="canonical" href="undefined"></head><body>` +
      `{"viewCount":{"runs":[{"text":"21,375"},{"text":" watching now"}]},"isLive":true}` +
      `${liveRefs},${otherRefs}</body></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: true, videoId: "rFZHOHl-L8A" });
  });

  it("falls back to embedded watch data when canonical points at the channel (mobile variant)", () => {
    const liveRefs = Array(8).fill(`"videoId":"rFZHOHl-L8A"`).join(",");
    const html =
      `<html><head><link rel="canonical" href="https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/live"></head>` +
      `<body>"isLive":true,${liveRefs}</body></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: true, videoId: "rFZHOHl-L8A" });
  });

  it("stays offline when isLive is present but no video id is clearly primary", () => {
    const html = `<html><head></head><body>"isLive":true,"videoId":"rFZHOHl-L8A"</body></html>`;
    expect(parseYouTubeLiveStatus(html)).toEqual({ live: false, videoId: null });
  });

  it("stays offline when video ids exist but nothing is live", () => {
    const html = `<html><head></head><body>"videoId":"rFZHOHl-L8A","videoId":"rFZHOHl-L8A","videoId":"rFZHOHl-L8A"</body></html>`;
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
