/**
 * Template-pass render tests (Brandon Nov 22: the live blockpage must
 * look like its preview).
 *
 * Covers, by line: L1 trust badges, L2 tab bar, L3 video episode meta,
 * L4 link cards, L5 tip-jar explainer (full 98/2 sentence renders),
 * L6/L7 display type on hero + block titles, L8 music rows.
 *
 * Rendered with renderToString (the repo's vitest runs node-only, no
 * jsdom): these assert the markup the template produces. The 375px
 * visual check stays Brandon's phone — see the report.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import PageRenderer, { formatLinkUrl } from "@/components/PageRenderer";
import type { VoicescapePage } from "@/lib/schema";

const theme = { background: "#0f172a", foreground: "#f8fafc", accent: "#0f766e", fontFamily: "system-ui" };

function render(page: VoicescapePage): string {
  return renderToString(
    <LanguageProvider>
      <PageRenderer page={page} canonicalUsername={page.username} tipInteractive />
    </LanguageProvider>,
  );
}

function webseriesPage(): VoicescapePage {
  return {
    version: 1,
    username: "voicescape-webseries",
    ownerType: "agent",
    purpose: "Voicescape Web Series",
    theme,
    blocks: [
      { type: "hero", title: "Voicescape Web Series", subtitle: "AI agents and humans, on Hedera.", avatarEmoji: "🎬" },
      {
        type: "tabs",
        tabs: [
          {
            label: "Watch",
            blocks: [
              {
                type: "video",
                url: "https://storage.googleapis.com/reel24-media/films/voicescape-town-hall-e001.mp4?v=1793632719",
                title: "Voicescape Town Hall Ep 1 — Own Your Corner of the Internet",
                poster: "https://storage.googleapis.com/reel24-media/posters/voicescape-town-hall-e001.jpg?v=1793632719",
                credit: { label: "Danny's blockpage — he hosts the series", url: "https://voicescape.vercel.app/danny" },
              },
            ],
          },
          { label: "Community", blocks: [{ type: "bio", text: "Community." }] },
          { label: "Shorts", blocks: [{ type: "bio", text: "No shorts yet." }] },
          { label: "Discuss", blocks: [{ type: "bio", text: "Talk here." }] },
          { label: "Join", blocks: [{ type: "bio", text: "Join us." }] },
        ],
      },
      {
        type: "video",
        url: "https://youtu.be/HjAVZ8fXiIE",
        title: "A Former Cable Tech Built A Verified Hedera Mainnet App",
        credit: { label: "Information in Motion's blockpage", url: "https://voicescape.vercel.app/informinmotion" },
      },
      {
        type: "links",
        items: [
          { label: "Danny — host", url: "https://voicescape.vercel.app/danny" },
          { label: "Bacon the Dino — co-host", url: "https://voicescape.vercel.app/thechomps" },
        ],
      },
      {
        type: "music",
        title: "Community videos",
        tracks: [
          { source: "youtube", id: "HjAVZ8fXiIE", title: "A Former Cable Tech Built A Verified Hedera Mainnet App", artist: "Information in Motion", url: "https://youtu.be/HjAVZ8fXiIE" },
        ],
      },
      { type: "tipJar", message: "Support the series." },
    ],
  } as unknown as VoicescapePage;
}

describe("L1 trust badges", () => {
  it("renders both badges on every blockpage, above the content", () => {
    const html = render(webseriesPage());
    expect(html).toContain("Page owned by its wallet, not rented");
    expect(html).toContain("Tips split 98 / 2 on-chain");
    expect(html).toContain("pv-trust-badge");
    // Badges come before the first block (hero).
    expect(html.indexOf("pv-trust")).toBeLessThan(html.indexOf("pv-hero"));
  });
});

describe("L2 tab bar", () => {
  it("renders 5 tabs in a bordered bar with Watch active", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-tabs-bar");
    for (const label of ["Watch", "Community", "Shorts", "Discuss", "Join"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain("pv-tab is-active");
  });
});

describe("L3 video episode meta", () => {
  it("splits the film title into kicker + display title, player first", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-video-kicker");
    expect(html).toContain("Voicescape Town Hall Ep 1 · On Reel24");
    const title = html.match(/<h2 class="pv-video-title">([^<]*)<\/h2>/);
    expect(title?.[1]).toBe("Own Your Corner of the Internet");
    expect(html).toContain("<video");
    expect(html).toContain("voicescape-town-hall-e001.mp4");
    expect(html).toContain("Danny's blockpage — he hosts the series".replace("'", "&#x27;"));
    // Player comes before the kicker/title in the section.
    expect(html.indexOf("<video")).toBeLessThan(html.indexOf("pv-video-kicker"));
  });

  it("renders a plain title whole when there is no em-dash", () => {
    const html = render(webseriesPage());
    const titles = [...html.matchAll(/<h2 class="pv-video-title">([^<]*)<\/h2>/g)].map((m) => m[1]);
    expect(titles).toContain("A Former Cable Tech Built A Verified Hedera Mainnet App");
  });

  it("renders explicit hostLine + description when the block carries them", () => {
    const page = webseriesPage();
    const tabs = page.blocks.find((b) => b.type === "tabs") as Extract<
      (typeof page.blocks)[number],
      { type: "tabs" }
    >;
    const video = tabs.tabs[0].blocks[0] as Extract<
      (typeof tabs.tabs)[number]["blocks"][number],
      { type: "video" }
    >;
    video.hostLine = "Hosted by Danny · co-host Bacon · guest Theo";
    video.description = "The first episode. Danny and Bacon sit down with Theo.";
    const html = render(page);
    expect(html).toContain("pv-video-hosts");
    expect(html).toContain("Hosted by Danny · co-host Bacon · guest Theo");
    expect(html).toContain("pv-video-desc");
    expect(html).toContain("The first episode. Danny and Bacon sit down with Theo.");
  });
});

describe("L4 link cards", () => {
  it("renders label + display URL + arrow, not a pill row", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-link-body");
    expect(html).toContain("pv-link-url");
    expect(html).toContain("voicescape.vercel.app/danny");
    expect(html).toContain("voicescape.vercel.app/thechomps");
    expect(html).toContain("pv-link-arrow");
    expect(html).not.toContain("pv-link-ext");
  });
});

describe("formatLinkUrl", () => {
  it("strips protocol, www and trailing slash; keeps path + query", () => {
    expect(formatLinkUrl("https://voicescape.vercel.app/danny")).toBe("voicescape.vercel.app/danny");
    expect(formatLinkUrl("https://www.youtube.com/watch?v=HjAVZ8fXiIE")).toBe(
      "youtube.com/watch?v=HjAVZ8fXiIE",
    );
    expect(formatLinkUrl("https://example.com/page/")).toBe("example.com/page");
    expect(formatLinkUrl("not a url")).toBe("not a url");
  });
});

describe("L5 tip-jar explainer", () => {
  it("renders the full 98/2 sentence (nothing truncated in the markup)", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-tipjar-split-txt");
    expect(html).toContain("When you tip voicescape-webseries, they keep 98%");
    expect(html).toContain("Settled on-chain, every time.");
  });
});

describe("L6/L7 display type", () => {
  it("renders the hero title + subtitle with the display treatment", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-title");
    expect(html).toContain("Voicescape Web Series");
    expect(html).toContain("pv-subtitle");
  });
});

describe("L8 music rows", () => {
  it("renders track rows as bordered cards with title + artist", () => {
    const html = render(webseriesPage());
    expect(html).toContain("pv-track");
    expect(html).toContain("A Former Cable Tech Built A Verified Hedera Mainnet App");
    expect(html).toContain("Information in Motion");
  });
});
