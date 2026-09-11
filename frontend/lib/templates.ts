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
];
