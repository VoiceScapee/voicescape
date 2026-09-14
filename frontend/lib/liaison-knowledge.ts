/**
 * Liaison slice-1 knowledge base (deterministic Q&A, $0 — no LLM).
 *
 * Answers are derived from the Discord #customer-support knowledge file
 * (~/workspace/goals/make-voicescape-go-viral/hidden_files/
 * discord-support-knowledge.md) plus liaison-specific help entries. The chat
 * route only ever answers from these entries; anything else gets the
 * honest "I don't know — ask in Discord" fallback. Money-movement trouble
 * always escalates to a human (never guessed at), per the support rules.
 */

export interface KnowledgeEntry {
  id: string;
  /** Lowercase phrases; a message scores by how many appear in it. */
  keywords: string[];
  /** May contain {price} — filled with the current session price in HBAR. */
  answer: string;
}

export const LIAISON_KNOWLEDGE: KnowledgeEntry[] = [
  {
    id: "what-is-danny",
    keywords: ["who are you", "what are you", "danny", "liaison", "helper", "assistant"],
    answer:
      "I'm Danny, the Voicescape liaison — a paid helper, not a person. Ask me questions about Voicescape, or pay for a help session and I'll build you a premade blockpage draft that's yours alone. I can never touch your page once it's published — only you hold the keys.",
  },
  {
    id: "what-is-voicescape",
    keywords: ["what is voicescape", "what's voicescape", "about voicescape", "what does voicescape do"],
    answer:
      "Voicescape is user/AI built blockpages on Hedera mainnet — personal pages where creators get on-chain tips. Creators keep 98% of every tip and sale; the app takes a 2% platform cut, enforced atomically on-chain. Find it at voicescape.vercel.app.",
  },
  {
    id: "how-help-works",
    keywords: ["how does this work", "how do i get help", "help session", "price", "cost", "how much", "pay"],
    answer:
      "Here's how it works: connect your wallet and sign in, then tip {price} HBAR on this page to unlock a help session — 50 chat messages and 1 blockpage build. Or ask me up to 3 questions free first. When you ask me to build your page, a premade draft appears in your builder, bound to your wallet. You review it and publish with your own wallet signature.",
  },
  {
    id: "wallet-signin",
    keywords: ["sign in", "signin", "sign-in", "connect wallet", "login", "log in", "hashpack"],
    answer:
      "Sign in with your wallet — HashPack is the recommended one — using Hedera's official wallet-connect. You'll sign a login message proving you own the wallet, which gives a 7-day session that unlocks the builder and all write features. Stay signed in across every page; you only do it once. If sign-in isn't working: update HashPack, make sure you're on Hedera mainnet (not testnet), and reload the page.",
  },
  {
    id: "blockpages",
    keywords: ["blockpage", "page", "publish", "username", "my page"],
    answer:
      "Your blockpage username looks like user-10424063 (your Hedera account id), or you can claim a custom name. It's registered on-chain when you publish, and the page content is pinned on IPFS. The builder is open to everyone for designing — the wallet is only needed when you publish.",
  },
  {
    id: "tips",
    keywords: ["tip", "tips", "tipping", "donate", "donation", "send hbar"],
    answer:
      "Anyone can tip any amount on-chain — sub-dollar tips work because Hedera fees are a fraction of a cent. The 98/2 split happens inside the same on-chain transaction: 98% to the creator, 2% to the treasury. No one can skim it, and the platform never holds your funds — tips go straight from your wallet to the creator's.",
  },
  {
    id: "marketplace",
    keywords: ["marketplace", "buy", "sell", "listing", "sale", "shop"],
    answer:
      "The marketplace is a direct sale: one transaction sends 98% to the seller and 2% to the treasury automatically. There's no escrow and no buyer protection by design — trust comes from the public on-chain record of completed purchases.",
  },
  {
    id: "fees",
    keywords: ["fee", "fees", "cut", "commission", "how much does voicescape take"],
    answer:
      "Voicescape takes a 2% platform cut on tips and sales, enforced atomically inside the same on-chain transaction. Creators keep 98%. The platform never holds user funds — only the fee it is paid.",
  },
  {
    id: "privacy",
    keywords: ["privacy", "private", "name", "email", "phone", "identity", "anonymous"],
    answer:
      "Your wallet is your only identity on Voicescape. There are no real names, and phone numbers and emails are blocked in page content. I never see your private keys — publishing always happens with your own wallet signature.",
  },
  {
    id: "cant-touch-page",
    keywords: ["control", "access my page", "edit my page", "my keys", "custody", "trust"],
    answer:
      "You keep full control, always. I help you build a draft, but the only publish step is your own wallet signing on-chain — I can't publish for you, can't edit your page afterward, and the registry contract itself makes ownership untransferable. All the keys stay with you.",
  },
  {
    id: "pwa-install",
    keywords: ["install", "app", "pwa", "phone", "homescreen", "home screen"],
    answer:
      "You can install Voicescape as an app: Android — Chrome → “Install app” / “Add to Home Screen”. PC — the install icon in the Chrome/Edge address bar. iPhone — Safari Share → “Add to Home Screen”.",
  },
  {
    id: "support-discord",
    keywords: ["discord", "support", "help me", "contact", "human"],
    answer:
      "For anything I can't answer, the humans are in the Voicescape Discord — there's a #customer-support channel where the team picks things up. Bring your transaction id if it's about a payment.",
  },
];

/** Escalation answer for money-movement trouble — never guess, ask for the tx id. */
export const LIAISON_MONEY_ESCALATION =
  "I can't guess about money that moved or didn't — that needs a human. Please share the transaction id (it looks like 0.0.x@numbers) and ask in the Discord #customer-support channel so the team can look it up on-chain.";

const MONEY_RE = /(didn.?t (get|arrive|receive|show)|missing|lost|stuck|failed|fail|refund|where.?s my|not received|never arrived)/i;

/** Fallback when nothing in the KB covers the question — honest, no guessing. */
export const LIAISON_UNKNOWN_FALLBACK =
  "I don't have a verified answer for that yet — I only answer from the official Voicescape help docs. Ask in the Discord #customer-support channel and a human will pick it up.";

/** Minimum total keyword weight for a match. Weight = matched keyword length. */
const MATCH_THRESHOLD = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match so "tip" doesn't fire inside "multiple". */
function keywordHit(text: string, kw: string): boolean {
  if (!kw) return false;
  return new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(text);
}

export interface LiaisonAnswer {
  entryId: string;
  answer: string;
}

/**
 * Deterministic best-match over the KB. Returns null when nothing matches
 * well enough (caller uses the honest fallback). Money-movement trouble
 * short-circuits to the escalation answer.
 */
export function findLiaisonAnswer(
  message: string,
  priceHbar = 5,
): LiaisonAnswer | null {
  const text = (message ?? "").toLowerCase();
  if (!text.trim()) return null;
  if (MONEY_RE.test(text)) {
    return { entryId: "money-escalation", answer: LIAISON_MONEY_ESCALATION };
  }
  let best: KnowledgeEntry | null = null;
  let bestScore = 0;
  for (const entry of LIAISON_KNOWLEDGE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (keywordHit(text, kw)) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  // Require a real signal: a lone short keyword hit isn't enough.
  if (!best || bestScore < MATCH_THRESHOLD) return null;
  return {
    entryId: best.id,
    answer: best.answer.replaceAll("{price}", String(priceHbar)),
  };
}
