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
    name: "Throwback",
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
        { type: "gallery", images: ["🌃", "🛸", "💾"] },
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
  // ---- Real-world business templates ----
  {
    id: "restaurant",
    name: "Restaurant",
    description: "Menu, hours, reservations, and reviews — your restaurant on-chain.",
    page: {
      ...base("bella-cucina"),
      theme: {
        background: "#1a0f0a",
        foreground: "#faf3e8",
        accent: "#e8930c",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "Bella Cucina", subtitle: "Authentic Italian · Est. 1998", avatarEmoji: "🍽️" },
        { type: "bio", text: "Family-owned Italian restaurant serving handmade pasta, wood-fired pizza, and old-world hospitality. Every dish made fresh daily." },
        { type: "bio", text: "🕐 Mon–Thu 11am–10pm · Fri–Sat 11am–11pm · Sun 12pm–9pm\n📍 123 Main Street — walk-ins welcome" },
        {
          type: "links",
          items: [
            { label: "View Full Menu", url: "https://example.com/menu" },
            { label: "Order Online", url: "https://example.com/order" },
          ],
        },
        {
          type: "booking",
          title: "Reserve a table",
          items: [
            { label: "Dinner reservation", url: "https://example.com/reserve", note: "Parties of 1–8" },
            { label: "Private events", url: "https://example.com/events", note: "Banquet room · up to 40 guests" },
          ],
        },
        {
          type: "reviews",
          title: "Guest reviews",
          entries: [
            { name: "Maria", message: "Best carbonara outside of Rome. The tiramisu is unreal.", date: "2026-09-01" },
          ],
        },
        { type: "tipJar", message: "Enjoyed your meal? Tips go directly to our team on-chain." },
      ],
    },
  },
  {
    id: "movie-theater",
    name: "Movie Theater",
    description: "Now showing, showtimes, tickets, and concessions — cinema on-chain.",
    page: {
      ...base("starlight-cinema"),
      theme: {
        background: "#0a0a0f",
        foreground: "#f5f0e8",
        accent: "#dc2626",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Starlight Cinema", subtitle: "4K Laser · Dolby Atmos · Recliners", avatarEmoji: "🎬" },
        { type: "bio", text: "Your neighborhood cinema with 8 screens, luxury recliners, and the best popcorn in town. Student and senior discounts every Tuesday." },
        {
          type: "gallery",
          images: ["🎬", "🍿", "🎟️", "🌟"],
        },
        {
          type: "booking",
          title: "Buy tickets",
          items: [
            { label: "Today's showtimes", url: "https://example.com/showtimes", note: "Matinee · Evening · Late night" },
            { label: "Group bookings", url: "https://example.com/groups", note: "10+ tickets · 15% off" },
          ],
        },
        {
          type: "links",
          items: [
            { label: "Full schedule", url: "https://example.com/schedule" },
            { label: "Concessions menu", url: "https://example.com/concessions" },
          ],
        },
        {
          type: "reviews",
          title: "Moviegoer reviews",
          entries: [
            { name: "Jake", message: "Recliners are amazing and the sound system is incredible.", date: "2026-08-28" },
          ],
        },
        { type: "tipJar", message: "Love the experience? Tip our crew — it goes straight on-chain." },
      ],
    },
  },
  {
    id: "retail-shop",
    name: "Retail Shop",
    description: "Showcase products, share your story, and connect with shoppers.",
    page: {
      ...base("corner-boutique"),
      theme: {
        background: "#ffffff",
        foreground: "#1a1a1a",
        accent: "#0ea5e9",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Corner Boutique", subtitle: "Curated goods · Locally owned", avatarEmoji: "🛍️" },
        { type: "bio", text: "A neighborhood shop for unique finds — clothing, home goods, and gifts you won't see anywhere else. New arrivals every Friday." },
        { type: "bio", text: "🕐 Mon–Sat 10am–8pm · Sun 12pm–6pm\n📍 456 Elm Avenue" },
        {
          type: "gallery",
          images: ["👗", "👜", "🕯️", "🎁"],
        },
        {
          type: "links",
          items: [
            { label: "Shop online", url: "https://example.com/shop" },
            { label: "New arrivals", url: "https://example.com/new" },
          ],
        },
        {
          type: "booking",
          title: "In-store services",
          items: [
            { label: "Personal styling session", url: "https://example.com/styling", note: "Free · 30 min" },
            { label: "Gift wrapping", url: "https://example.com/gifts", note: "Complimentary with purchase" },
          ],
        },
        {
          type: "reviews",
          title: "Shopper reviews",
          entries: [
            { name: "Priya", message: "Always find something special here. Staff is so helpful.", date: "2026-09-05" },
          ],
        },
      ],
    },
  },
  {
    id: "salon",
    name: "Salon & Barbershop",
    description: "Services, stylists, online booking, and reviews for your salon.",
    page: {
      ...base("luxe-cuts"),
      theme: {
        background: "#141014",
        foreground: "#f9f1e7",
        accent: "#d4a853",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "Luxe Cuts", subtitle: "Salon & Barbershop · Walk-ins welcome", avatarEmoji: "💈" },
        { type: "bio", text: "Precision cuts, color, and grooming from master stylists. Hot-towel shaves, beard trims, and full color services in a relaxed studio." },
        { type: "bio", text: "✂️ Cuts from $35 · Color from $85 · Beard trim $20\n🕐 Tue–Sat 9am–7pm" },
        {
          type: "booking",
          title: "Book an appointment",
          items: [
            { label: "Book online", url: "https://example.com/book", note: "Pick your stylist & time" },
            { label: "First visit consult", url: "https://example.com/consult", note: "Free · 15 min" },
          ],
        },
        {
          type: "top8",
          title: "Our stylists",
          friends: [
            { name: "Rosa", avatarEmoji: "💇‍♀️", url: "https://example.com/rosa" },
            { name: "Marcus", avatarEmoji: "💇‍♂️", url: "https://example.com/marcus" },
            { name: "Lena", avatarEmoji: "🎨" },
          ],
        },
        {
          type: "reviews",
          title: "Client reviews",
          entries: [
            { name: "Dev", message: "Marcus gave me the best fade I've ever had. Booked my next three already.", date: "2026-09-03" },
          ],
        },
        { type: "tipJar", message: "Happy with your cut? Tip your stylist directly on-chain." },
      ],
    },
  },
  {
    id: "gym",
    name: "Gym & Fitness",
    description: "Class schedules, memberships, trainers, and member reviews.",
    page: {
      ...base("iron-pulse"),
      theme: {
        background: "#0d0d0d",
        foreground: "#f2f2f2",
        accent: "#a3e635",
        fontFamily: "Impact, 'Arial Black', 'Helvetica Neue', sans-serif",
      },
      blocks: [
        { type: "hero", title: "IRON PULSE", subtitle: "24/7 gym · No contracts · First week free", avatarEmoji: "💪" },
        { type: "bio", text: "Serious training for every level. Free weights, machines, cardio deck, and 40+ weekly classes. Personal training and nutrition coaching available." },
        { type: "bio", text: "💲 Day pass $15 · Monthly $45 · Annual $400\n🕐 Open 24/7 · Staffed 6am–10pm" },
        {
          type: "booking",
          title: "Classes & training",
          items: [
            { label: "Class schedule", url: "https://example.com/classes", note: "HIIT · Yoga · Spin · Boxing" },
            { label: "Book personal training", url: "https://example.com/pt", note: "First session free" },
          ],
        },
        {
          type: "gallery",
          images: ["🏋️", "🧘", "🚴", "🥊"],
        },
        {
          type: "links",
          items: [
            { label: "Join now", url: "https://example.com/join" },
            { label: "Membership plans", url: "https://example.com/plans" },
          ],
        },
        {
          type: "reviews",
          title: "Member reviews",
          entries: [
            { name: "Tanya", message: "Clean, never overcrowded, and the 6am HIIT class is addictive.", date: "2026-08-30" },
          ],
        },
      ],
    },
  },
  {
    id: "coffee-shop",
    name: "Coffee Shop",
    description: "Menu, hours, community vibes, and a tip jar for your favorite baristas.",
    page: {
      ...base("daily-grind"),
      theme: {
        background: "#2b1d16",
        foreground: "#f5ead9",
        accent: "#c98a4b",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "The Daily Grind", subtitle: "Single-origin coffee · Baked fresh daily", avatarEmoji: "☕" },
        { type: "bio", text: "Your third place. Locally roasted beans, homemade pastries, and free Wi-Fi. Come for the coffee, stay for the community." },
        { type: "bio", text: "☕ Espresso $3.50 · Pour-over $5 · Pastries from $3\n🕐 Mon–Fri 6am–6pm · Sat–Sun 7am–4pm" },
        { type: "music", title: "Shop vibes", tracks: [] },
        {
          type: "links",
          items: [
            { label: "Full menu", url: "https://example.com/menu" },
            { label: "Order ahead", url: "https://example.com/order" },
          ],
        },
        {
          type: "guestbook",
          entries: [
            { name: "Sam", message: "Best oat milk latte in the neighborhood!", date: "2026-09-07" },
          ],
        },
        { type: "tipJar", message: "Love your barista? Tips go straight to the team on-chain." },
      ],
    },
  },
  {
    id: "real-estate",
    name: "Real Estate",
    description: "Listings, agent bio, viewing bookings, and client reviews.",
    page: {
      ...base("prime-properties"),
      theme: {
        background: "#0f1b2d",
        foreground: "#f0f4f8",
        accent: "#38bdf8",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Jordan Blake", subtitle: "Licensed Realtor® · 12 yrs · $200M+ sold", avatarEmoji: "🏠" },
        { type: "bio", text: "I help buyers find home and sellers get top dollar. Hyperlocal expertise, honest advice, and negotiation that protects your interests." },
        {
          type: "gallery",
          images: ["🏡", "🏢", "🌇", "🔑"],
        },
        {
          type: "booking",
          title: "Work with me",
          items: [
            { label: "Schedule a viewing", url: "https://example.com/viewing", note: "In-person or virtual" },
            { label: "Free home valuation", url: "https://example.com/valuation", note: "Sellers · 15 min call" },
          ],
        },
        {
          type: "links",
          items: [
            { label: "Current listings", url: "https://example.com/listings" },
            { label: "Sold properties", url: "https://example.com/sold" },
          ],
        },
        {
          type: "reviews",
          title: "Client reviews",
          entries: [
            { name: "The Parkers", message: "Jordan found us our dream home below asking in a hot market.", date: "2026-08-20" },
          ],
        },
      ],
    },
  },
  {
    id: "auto-repair",
    name: "Auto Repair",
    description: "Services, pricing, appointment booking, and verified customer reviews.",
    page: {
      ...base("honest-auto"),
      theme: {
        background: "#17171a",
        foreground: "#f4f4f5",
        accent: "#f97316",
        fontFamily: "Arial, Helvetica, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Honest Auto", subtitle: "ASE-certified · Free diagnostics · Shuttle service", avatarEmoji: "🔧" },
        { type: "bio", text: "Straight-up car care with upfront pricing. Oil changes, brakes, diagnostics, and full repairs — no upsells, ever. All work backed by a 2-year warranty." },
        { type: "bio", text: "🔧 Oil change $49 · Brake pads $189/axle · Diagnostics FREE\n🕐 Mon–Fri 8am–6pm · Sat 9am–2pm" },
        {
          type: "booking",
          title: "Book service",
          items: [
            { label: "Schedule appointment", url: "https://example.com/book", note: "Free shuttle while you wait" },
            { label: "Request a quote", url: "https://example.com/quote", note: "Response within 2 hours" },
          ],
        },
        {
          type: "links",
          items: [
            { label: "Full service menu", url: "https://example.com/services" },
            { label: "Coupons & specials", url: "https://example.com/deals" },
          ],
        },
        {
          type: "reviews",
          title: "Customer reviews",
          entries: [
            { name: "Chris", message: "Quoted $300 less than the dealership for the same brake job. Done in 2 hours.", date: "2026-09-02" },
          ],
        },
        { type: "tipJar", message: "Great service? Tip your tech directly on-chain." },
      ],
    },
  },
  // ---- Expressive originals: bold, personal, Web3-native ----
  {
    id: "aurora-drift",
    name: "Aurora Drift",
    description: "Flowing northern-light gradients for dreamers, makers, and late-night thinkers.",
    page: {
      ...base("aurora.wav"),
      theme: {
        background:
          "radial-gradient(ellipse 55% 40% at 15% 25%, rgba(94,234,212,0.28), transparent 70%), radial-gradient(ellipse 60% 45% at 85% 40%, rgba(167,139,250,0.32), transparent 70%), radial-gradient(ellipse 50% 40% at 50% 85%, rgba(236,72,153,0.22), transparent 70%), linear-gradient(180deg, #060a24 0%, #0b1035 100%)",
        foreground: "#f0f4ff",
        accent: "#5eead4",
        fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
      },
      blocks: [
        { type: "hero", title: "aurora.wav", subtitle: "chasing light, making sound", avatarEmoji: "🌠" },
        { type: "bio", text: "currently: somewhere between a daydream and a deadline ✨ send good playlists, not small talk." },
        { type: "bio", text: "i make things that glow — music, visuals, weird little web experiments. this page is my sketchbook and my stage. come back often, it changes when i do." },
        { type: "music", title: "what i'm making 🎧", tracks: [] },
        {
          type: "top8",
          title: "people who get it",
          friends: [
            { name: "lumen", avatarEmoji: "💡" },
            { name: "nocturne.jpg", avatarEmoji: "🌃" },
            { name: "soft.focus", avatarEmoji: "🫧" },
            { name: "violet.hour", avatarEmoji: "🟣" },
            { name: "daydream.fm", avatarEmoji: "📻" },
          ],
        },
        { type: "gallery", images: ["🌠", "🎨", "🌊", "💭", "🫧", "🪩"] },
        {
          type: "guestbook",
          entries: [
            { name: "lumen", message: "this page feels like the sky at 2am. never change it. (okay, change it, that's the point)", date: "2026-09-01" },
          ],
        },
        {
          type: "links",
          items: [{ label: "my latest drop", url: "https://example.com" }],
        },
        { type: "tipJar", message: "fuel the next project — tips land on-chain, straight to the source ✨" },
      ],
    },
  },
  {
    id: "block-explorer",
    name: "Block Explorer",
    description: "Web3-native identity: dark terminal, tx-hash motifs. My wallet is my resume.",
    page: {
      ...base("0xCreator"),
      theme: {
        background:
          "repeating-linear-gradient(0deg, rgba(74,222,128,0.04) 0 1px, transparent 1px 4px), linear-gradient(180deg, #04070d 0%, #0a0f1a 100%)",
        foreground: "#e2e8f0",
        accent: "#4ade80",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      },
      blocks: [
        { type: "hero", title: "0xCreator", subtitle: "my wallet is my resume", avatarEmoji: "⛓️" },
        { type: "bio", text: "$ status: building in public\n$ last_commit: today\n$ vibe: shipped > perfect" },
        { type: "bio", text: "on-chain builder. everything i make settles in public — code, art, ideas. no pitch decks, just transactions. verify, don't trust." },
        { type: "music", title: "coding playlist 🔊", tracks: [] },
        {
          type: "top8",
          title: "verified connections",
          friends: [
            { name: "0xBuilder", avatarEmoji: "🧱" },
            { name: "0xArtist", avatarEmoji: "🎨" },
            { name: "node.runner", avatarEmoji: "🖥️" },
            { name: "hash.packer", avatarEmoji: "📦" },
            { name: "consensus.queen", avatarEmoji: "🟢" },
          ],
        },
        { type: "gallery", images: ["⛓️", "🧱", "🔏", "📦", "🔍", "🟢"] },
        {
          type: "guestbook",
          entries: [
            { name: "0xBuilder", message: "confirmed: this human ships. tx history doesn't lie.", date: "2026-08-22" },
          ],
        },
        {
          type: "links",
          items: [
            { label: "my contracts", url: "https://example.com" },
            { label: "github", url: "https://example.com" },
          ],
        },
        { type: "tipJar", message: "tips settle on-chain, obviously. 98/2, verifiable by anyone ⛓️" },
      ],
    },
  },
  {
    id: "lofi-room",
    name: "Lo-Fi Room",
    description: "Warm lamplight and rain sounds. A cozy corner for bedroom creators.",
    page: {
      ...base("the-lofi-room"),
      theme: {
        background:
          "radial-gradient(ellipse 60% 45% at 50% 110%, rgba(245,158,11,0.25), transparent 70%), linear-gradient(180deg, #241407 0%, #3a2110 55%, #1c1008 100%)",
        foreground: "#fdf6ec",
        accent: "#f59e0b",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "the lofi room", subtitle: "beats, tea & slow mornings", avatarEmoji: "🎧" },
        { type: "bio", text: "currently: rain sounds + unfinished songs 🌧️ the kettle's on, the loop is looping, you're welcome to stay a while." },
        { type: "bio", text: "i make quiet music for loud minds. everything here is recorded in one room, mostly after midnight, always with feeling. put this page on in the background and get cozy." },
        { type: "music", title: "bedroom tapes 📼", tracks: [] },
        {
          type: "top8",
          title: "regulars at the table",
          friends: [
            { name: "tea.first", avatarEmoji: "🍵" },
            { name: "window.rain", avatarEmoji: "🌧️" },
            { name: "tape.hiss", avatarEmoji: "📼" },
            { name: "candle.light", avatarEmoji: "🕯️" },
            { name: "slow.sunday", avatarEmoji: "🛋️" },
          ],
        },
        { type: "gallery", images: ["☕", "🎧", "🕯️", "📼", "🌧️", "🧸"] },
        {
          type: "guestbook",
          entries: [
            { name: "tea.first", message: "fell asleep to your latest loop. woke up happier. 10/10.", date: "2026-09-05" },
          ],
        },
        {
          type: "links",
          items: [{ label: "all my tapes", url: "https://example.com" }],
        },
        { type: "tipJar", message: "buy me a coffee? tips go straight on-chain ☕" },
      ],
    },
  },
  {
    id: "solarpunk-garden",
    name: "Solarpunk Garden",
    description: "Sunlit and hopeful — growing a kinder internet, one page at a time.",
    page: {
      ...base("the-garden"),
      theme: {
        background:
          "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(253,224,71,0.3), transparent 70%), radial-gradient(ellipse 45% 40% at 12% 80%, rgba(163,230,53,0.18), transparent 70%), linear-gradient(180deg, #1d3a1f 0%, #2c5a2e 60%, #16281a 100%)",
        foreground: "#f7fee7",
        accent: "#a3e635",
        fontFamily: "'Segoe UI', Verdana, Geneva, sans-serif",
      },
      blocks: [
        { type: "hero", title: "the garden", subtitle: "growing a kinder internet 🌱", avatarEmoji: "🌱" },
        { type: "bio", text: "currently: planting seeds, digital & otherwise 🌻 this page runs on sunlight and good intentions." },
        { type: "bio", text: "i believe the internet can be a garden, not a strip mall. i grow open-source projects, community spaces, and actual tomatoes. everything here is tended by hand." },
        { type: "music", title: "morning garden mix 🌻", tracks: [] },
        {
          type: "top8",
          title: "fellow gardeners",
          friends: [
            { name: "compost.queen", avatarEmoji: "🪱" },
            { name: "solar.sam", avatarEmoji: "☀️" },
            { name: "seed.library", avatarEmoji: "🌰" },
            { name: "bees.knees", avatarEmoji: "🐝" },
            { name: "wildflower.will", avatarEmoji: "🌼" },
          ],
        },
        { type: "gallery", images: ["🌱", "🌻", "🍃", "🦋", "☀️", "🌿"] },
        {
          type: "guestbook",
          entries: [
            { name: "bees.knees", message: "pollinated your guestbook. left some honey. keep growing 🐝", date: "2026-06-15" },
          ],
        },
        {
          type: "links",
          items: [{ label: "community seed swap", url: "https://example.com" }],
        },
        { type: "tipJar", message: "water the garden — tips go straight on-chain 🌱" },
      ],
    },
  },
  {
    id: "night-signal",
    name: "Night Signal",
    description: "Pirate-radio energy. You are the media — broadcast yourself.",
    page: {
      ...base("night-signal"),
      theme: {
        background:
          "radial-gradient(ellipse 50% 35% at 50% 30%, rgba(248,113,113,0.16), transparent 70%), repeating-linear-gradient(90deg, rgba(248,113,113,0.05) 0 2px, transparent 2px 7px), linear-gradient(180deg, #120607 0%, #1e0a0c 60%, #0b0505 100%)",
        foreground: "#fef2f2",
        accent: "#f87171",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
      },
      blocks: [
        { type: "hero", title: "NIGHT SIGNAL", subtitle: "you are the media 📡", avatarEmoji: "📡" },
        { type: "bio", text: "🔴 ON AIR: late-night thoughts, unfiltered. broadcasting from somewhere the algorithm can't find." },
        { type: "bio", text: "this is an independent station. no sponsors, no scripts, no permission needed. i talk about what matters at 1am — tech, truth, and the future we're actually going to live in. tune in." },
        { type: "music", title: "tonight's broadcast 🎙️", tracks: [] },
        {
          type: "top8",
          title: "fellow broadcasters",
          friends: [
            { name: "static.bloom", avatarEmoji: "📻" },
            { name: "midnight.modem", avatarEmoji: "💾" },
            { name: "frequency.fae", avatarEmoji: "🧚" },
            { name: "dead.air.dan", avatarEmoji: "🎚️" },
            { name: "pirate.polly", avatarEmoji: "🏴‍☠️" },
          ],
        },
        { type: "gallery", images: ["📡", "🎙️", "📻", "🌃", "🔴", "🎚️"] },
        {
          type: "guestbook",
          entries: [
            { name: "static.bloom", message: "signal came through crystal clear last night. keep transmitting.", date: "2026-09-08" },
          ],
        },
        {
          type: "links",
          items: [{ label: "listen to the archive", url: "https://example.com" }],
        },
        { type: "tipJar", message: "keep the signal alive — tips go straight on-chain 📡" },
      ],
    },
  },
  {
    id: "wanderer-atlas",
    name: "Wanderer Atlas",
    description: "A travel journal in page form. Collecting places, not things.",
    page: {
      ...base("atlas-in-progress"),
      theme: {
        background:
          "radial-gradient(ellipse 80% 45% at 50% 108%, rgba(251,146,60,0.35), transparent 70%), linear-gradient(180deg, #101c2e 0%, #274060 55%, #3d2b1f 100%)",
        foreground: "#faf5ec",
        accent: "#fb923c",
        fontFamily: "Georgia, 'Times New Roman', serif",
      },
      blocks: [
        { type: "hero", title: "atlas in progress", subtitle: "collecting places, not things 🧭", avatarEmoji: "🧭" },
        { type: "bio", text: "currently: somewhere with unfamiliar stars ✦ last stamped: somewhere i can't pronounce yet." },
        { type: "bio", text: "field notes from a life in motion. i go slow, stay long, and learn the names of things. this page is my journal, my map, and my postcard to everyone back home." },
        { type: "music", title: "road songs 🚂", tracks: [] },
        {
          type: "top8",
          title: "travel companions",
          friends: [
            { name: "window.seat", avatarEmoji: "🪟" },
            { name: "night.train", avatarEmoji: "🚂" },
            { name: "hostel.hana", avatarEmoji: "🏠" },
            { name: "summit.sue", avatarEmoji: "⛰️" },
            { name: "harbor.hugo", avatarEmoji: "⚓" },
          ],
        },
        { type: "gallery", images: ["🧭", "🗺️", "⛰️", "🌅", "🎒", "🚂"] },
        {
          type: "guestbook",
          entries: [
            { name: "night.train", message: "met you in a sleeper car outside nowhere. best conversation of the trip.", date: "2026-07-30" },
          ],
        },
        {
          type: "links",
          items: [{ label: "the full journal", url: "https://example.com" }],
        },
        { type: "tipJar", message: "fuel the next mile — tips go straight on-chain 🧭" },
      ],
    },
  },
];
