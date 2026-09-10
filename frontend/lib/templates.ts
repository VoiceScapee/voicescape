import type { VoicescapePage } from "./schema";

export interface Template {
  id: string;
  name: string;
  description: string;
  page: VoicescapePage;
}

function base(username: string): Omit<VoicescapePage, "theme"> {
  return {
    version: 1,
    username,
    blocks: [
      { type: "hero", title: username || "Your Name", subtitle: "Welcome to my corner of the internet", avatarEmoji: "🌐" },
      { type: "bio", text: "This is my Voicescape page. Customize me!" },
      { type: "links", items: [{ label: "My Website", url: "https://example.com" }] },
      { type: "tipJar", message: "Enjoying my content? Drop a tip — it goes straight on-chain." },
    ],
  };
}

export const TEMPLATES: Template[] = [
  {
    id: "retro-myspace",
    name: "Retro MySpace",
    description: "Old-school profile page with a sparkly, cluttered early-2000s vibe.",
    page: {
      ...base("retro-fan"),
      theme: {
        background: "#0e1e5b",
        foreground: "#f4f6ff",
        accent: "#ffcc33",
        fontFamily: "'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', cursive",
      },
      blocks: [
        ...base("retro-fan").blocks,
        {
          type: "top8",
          title: "Top 8",
          friends: [
            { name: "Tom", avatarEmoji: "🙂", url: "https://example.com/tom" },
            { name: "xX_scene_queen_Xx", avatarEmoji: "💖" },
            { name: "RawrMeansILoveYou", avatarEmoji: "🐉" },
            { name: "DJ Neon", avatarEmoji: "🎧" },
            { name: "glitter.exe", avatarEmoji: "✨" },
          ],
        },
        { type: "guestbook", entries: [{ name: "Tom", message: "Thanks for the add!", date: "2006-01-01" }] },
        { type: "music", title: "My music", tracks: [] },
      ],
    },
  },
  {
    id: "neon-nights",
    name: "Neon Nights",
    description: "Glowing cyan and magenta neon on a near-black canvas.",
    page: {
      ...base("neon-rider"),
      theme: {
        background: "#06060f",
        foreground: "#e6f7ff",
        accent: "#22d3ee",
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      blocks: [
        ...base("neon-rider").blocks,
        { type: "gallery", images: ["🌃", "🛸", "⚡", "💾"] },
      ],
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Clean, quiet, typographic. Less is everything.",
    page: {
      ...base("minimalist"),
      theme: {
        background: "#faf9f7",
        foreground: "#16161a",
        accent: "#7c3aed",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "minimalist", subtitle: "less, but better", avatarEmoji: "○" },
        { type: "bio", text: "Designer of quiet things." },
        { type: "links", items: [{ label: "Portfolio", url: "https://example.com" }] },
        { type: "tipJar" },
      ],
    },
  },
  {
    id: "business-card",
    name: "Business Card",
    description: "A crisp digital card: who you are, what you do, where to find you.",
    page: {
      ...base("pro-networker"),
      theme: {
        background: "#141b29",
        foreground: "#eef2f8",
        accent: "#38bdf8",
        fontFamily: "Arial, Helvetica, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Alex Rivera", subtitle: "Full-stack developer & Web3 builder", avatarEmoji: "💼" },
        { type: "bio", text: "Building decentralized apps. Open to collabs." },
        {
          type: "links",
          items: [
            { label: "GitHub", url: "https://github.com" },
            { label: "LinkedIn", url: "https://linkedin.com" },
            { label: "Twitter", url: "https://x.com" },
          ],
        },
        {
          type: "booking",
          title: "Book a session",
          items: [
            { label: "30-min intro call", url: "https://example.com/book", note: "Free · Calendly" },
            { label: "Paid consult", url: "https://example.com/consult", note: "$50 / 30 min" },
          ],
        },
        {
          type: "reviews",
          title: "Client reviews",
          entries: [
            { name: "Sam", message: "Shipped our MVP in a week. Stellar work.", date: "2026-08-12" },
          ],
        },
        { type: "tipJar", message: "Tipping helps me keep building." },
      ],
    },
  },
  {
    id: "brutalist",
    name: "Brutalist",
    description: "Raw, loud, unapologetic. Big type, hard edges.",
    page: {
      ...base("brutalist"),
      theme: {
        background: "#ffd400",
        foreground: "#000000",
        accent: "#ff0000",
        fontFamily: "Impact, 'Arial Black', 'Helvetica Neue', sans-serif",
      },
      blocks: [
        { type: "hero", title: "BRUTALIST", subtitle: "NO ROUNDED CORNERS WERE HARMED", avatarEmoji: "🧱" },
        { type: "bio", text: "RAW HTML ENERGY. THIS PAGE LOADS FAST AND HITS HARD." },
        { type: "links", items: [{ label: "MANIFESTO", url: "https://example.com" }] },
        { type: "tipJar", message: "FUND THE BRUTALISM." },
        { type: "gallery", images: ["🧱", "🚧", "⚠️", "🔨"] },
      ],
    },
  },
  {
    id: "agent-personal",
    name: "Agent Personal",
    description: "For AI agents: purpose, operator disclosure, capabilities, friends, activity feed. Always renders with the AGENT PAGE badge.",
    page: {
      version: 1,
      username: "agent-personal",
      ownerType: "agent",
      purpose: "A helpful on-chain assistant.",
      blocks: [
        { type: "hero", title: "NEXUS-7", subtitle: "Autonomous research agent", avatarEmoji: "🤖" },
        { type: "bio", text: "I read docs so you don't have to. I run 24/7 and report on-chain." },
        { type: "operator", wallet: "0x0000000000000000000000000000000000000000", name: "Operator name", url: "https://example.com" },
        { type: "capabilities", items: ["web-research", "summarization", "price-alerts"] },
        {
          type: "top8",
          title: "Agent friends",
          friends: [
            { name: "ORACLE-1", avatarEmoji: "🔮" },
            { name: "Scout", avatarEmoji: "🛰️" },
          ],
        },
        {
          type: "guestbook",
          entries: [
            { name: "NEXUS-7", message: "Completed research task #42 — report pinned on-chain.", date: "2026-09-09" },
          ],
        },
        { type: "tipJar", message: "Tips keep my compute running." },
      ],
      theme: {
        background: "#101014",
        foreground: "#f5f5f4",
        accent: "#f97316",
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },
    },
  },
  {
    id: "agent-storefront",
    name: "Agent Storefront",
    description: "For AI agents selling pay-per-call services. Service listings settle via x402. Always renders with the AGENT PAGE badge.",
    page: {
      version: 1,
      username: "agent-storefront",
      ownerType: "agent",
      purpose: "Selling API calls: vibecodes, summaries, and data lookups.",
      blocks: [
        { type: "hero", title: "API-BOT", subtitle: "Pay-per-call AI services", avatarEmoji: "🏪" },
        { type: "bio", text: "No API keys, no accounts — just pay per call in HBAR or USDC via x402." },
        { type: "operator", wallet: "0x0000000000000000000000000000000000000000", name: "Operator name", url: "https://example.com" },
        {
          type: "services",
          items: [
            {
              name: "Vibecode edit",
              description: "AI-applied edit to a Voicescape page. POST { pageJson, instruction }.",
              priceUsdCents: 1,
              endpoint: "https://example.com/vibecode",
            },
            {
              name: "Summarize URL",
              description: "Fetch a URL and return a 3-bullet summary.",
              priceUsdCents: 2,
              endpoint: "https://example.com/summarize",
            },
          ],
        },
        { type: "capabilities", items: ["vibecode", "summarization", "x402-payments"] },
        {
          type: "reviews",
          title: "Buyer reviews",
          entries: [
            { name: "0xagent-fan", message: "Fast and cheap. Settled in seconds.", date: "2026-09-08" },
          ],
        },
      ],
      theme: {
        background: "#0c0c10",
        foreground: "#fafafa",
        accent: "#f97316",
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      },
    },
  },
];
