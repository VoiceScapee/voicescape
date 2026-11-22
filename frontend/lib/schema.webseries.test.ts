/**
 * normalizeBlockForRender + isValidPage tests for the webseries blocks:
 * video, guestComments, poll, and the tipJar recipient username.
 */
import { describe, expect, it } from "vitest";
import { isValidPage, normalizeBlockForRender } from "./schema";

const theme = { background: "#000", foreground: "#fff", accent: "#f0f", fontFamily: "sans" };

describe("video block", () => {
  it("keeps a Reel24 MP4 with title, poster and maker credit", () => {
    const out = normalizeBlockForRender({
      type: "video",
      url: "https://storage.googleapis.com/reel24-media/films/voicescape-town-hall-e001.mp4?v=1793632719",
      title: "Voicescape Town Hall Ep 1",
      poster: "https://storage.googleapis.com/reel24-media/posters/voicescape-town-hall-e001.jpg?v=1793632719",
      credit: { label: "Danny's blockpage — he hosts", url: "https://voicescape.vercel.app/danny" },
    });
    expect(out).toEqual({
      type: "video",
      url: "https://storage.googleapis.com/reel24-media/films/voicescape-town-hall-e001.mp4?v=1793632719",
      title: "Voicescape Town Hall Ep 1",
      poster: "https://storage.googleapis.com/reel24-media/posters/voicescape-town-hall-e001.jpg?v=1793632719",
      credit: { label: "Danny's blockpage — he hosts", url: "https://voicescape.vercel.app/danny" },
    });
  });

  it("keeps a YouTube link and drops an unplayable URL", () => {
    expect(
      normalizeBlockForRender({ type: "video", url: "https://youtu.be/HjAVZ8fXiIE" }),
    ).toEqual({ type: "video", url: "https://youtu.be/HjAVZ8fXiIE" });
    expect(
      normalizeBlockForRender({ type: "video", url: "https://evil.example.com/x.mp4" }),
    ).toBeNull();
    expect(normalizeBlockForRender({ type: "video", url: "" })).toBeNull();
    expect(normalizeBlockForRender({ type: "video" })).toBeNull();
  });

  it("drops a credit missing label or url", () => {
    const out = normalizeBlockForRender({
      type: "video",
      url: "https://youtu.be/HjAVZ8fXiIE",
      credit: { label: "No link" },
    }) as { credit?: unknown };
    expect(out.credit).toBeUndefined();
  });
});

describe("guestComments block", () => {
  it("keeps thread + title, lowercases the thread, drops a bad thread", () => {
    expect(
      normalizeBlockForRender({ type: "guestComments", thread: "Ep1", title: "Talk about Ep 1" }),
    ).toEqual({ type: "guestComments", thread: "ep1", title: "Talk about Ep 1" });
    expect(normalizeBlockForRender({ type: "guestComments" })).toEqual({
      type: "guestComments",
    });
    expect(
      normalizeBlockForRender({ type: "guestComments", thread: "has spaces" }),
    ).toEqual({ type: "guestComments" });
  });
});

describe("poll block", () => {
  it("keeps question + options and derives a stable id from the question", () => {
    const out = normalizeBlockForRender({
      type: "poll",
      question: "What should the next episode cover?",
      options: ["Agent tips", "A live build"],
    });
    expect(out).toEqual({
      type: "poll",
      question: "What should the next episode cover?",
      options: ["Agent tips", "A live build"],
      id: "what-should-the-next-episode-cover",
    });
  });

  it("keeps an author-chosen id and caps options at 6", () => {
    const out = normalizeBlockForRender({
      type: "poll",
      id: "ep2-topic",
      question: "Q?",
      options: ["a", "b", "c", "d", "e", "f", "g", "h"],
    }) as { id: string; options: string[] };
    expect(out.id).toBe("ep2-topic");
    expect(out.options).toHaveLength(6);
  });

  it("returns null with fewer than 2 options or no question", () => {
    expect(
      normalizeBlockForRender({ type: "poll", question: "Q?", options: ["only one"] }),
    ).toBeNull();
    expect(
      normalizeBlockForRender({ type: "poll", question: "", options: ["a", "b"] }),
    ).toBeNull();
  });
});

describe("tipJar recipient", () => {
  it("keeps a valid recipient username, lowercased", () => {
    expect(
      normalizeBlockForRender({ type: "tipJar", username: "TheChomps", message: "Tip Bacon" }),
    ).toEqual({ type: "tipJar", username: "thechomps", message: "Tip Bacon" });
  });

  it("drops an invalid recipient and keeps the page-owner jar", () => {
    expect(normalizeBlockForRender({ type: "tipJar", username: "not a name!" })).toEqual({
      type: "tipJar",
    });
    expect(normalizeBlockForRender({ type: "tipJar" })).toEqual({ type: "tipJar" });
  });
});

describe("isValidPage with the new blocks", () => {
  it("accepts a page using all three new block types", () => {
    const page = {
      version: 1,
      username: "voicescape-webseries",
      theme,
      blocks: [
        { type: "video", url: "https://youtu.be/HjAVZ8fXiIE" },
        { type: "guestComments", thread: "discuss" },
        { type: "poll", question: "Q?", options: ["a", "b"] },
        { type: "tipJar", username: "danny" },
        {
          type: "tabs",
          tabs: [
            { label: "Watch", blocks: [{ type: "bio", text: "x" }] },
            { label: "Community", blocks: [{ type: "bio", text: "x" }] },
            { label: "Shorts", blocks: [{ type: "bio", text: "x" }] },
            { label: "Discuss", blocks: [{ type: "bio", text: "x" }] },
            { label: "Join", blocks: [{ type: "bio", text: "x" }] },
          ],
        },
      ],
    };
    expect(isValidPage(page)).toBe(true);
  });

  it("rejects a poll with 1 option and a video without a url", () => {
    const base = { version: 1, username: "x", theme, blocks: [] as unknown[] };
    expect(isValidPage({ ...base, blocks: [{ type: "poll", question: "Q?", options: ["a"] }] })).toBe(false);
    expect(isValidPage({ ...base, blocks: [{ type: "video" }] })).toBe(false);
    expect(isValidPage({ ...base, blocks: [{ type: "video", url: "https://youtu.be/x" }] })).toBe(true);
  });
});
