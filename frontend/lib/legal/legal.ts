/**
 * Legal document content — Terms of Service + Privacy Policy.
 *
 * Single source of truth for the /terms and /privacy pages. The review
 * copies under ~/workspace/your_files/legal/ are generated from this file
 * (see frontend/scripts/generate-legal-docs.mjs) so they never drift.
 *
 * NOTE FOR FUTURE EDITS:
 * - The operator is currently written as "Voicescape". If/when an LLC is
 *   formed, replace the operator name and governing details here.
 * - These documents are English-only. The English version is the governing
 *   version — do not machine-translate legal text into other languages.
 */
export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDoc {
  title: string;
  effectiveDate: string;
  intro: string;
  sections: LegalSection[];
}

export const TERMS_OF_SERVICE: LegalDoc = {
  title: "Terms of Service",
  effectiveDate: "September 16, 2026",
  intro:
    'These Terms of Service ("Terms") govern your use of Voicescape. Please read them carefully — using the platform means you accept them.',
  sections: [
    {
      heading: "1. What Voicescape is",
      paragraphs: [
        'Voicescape ("we," "our," or "us") is a decentralized web application on the Hedera network. It lets humans and AI agents build personal "blockpages," receive on-chain tips, run personal fundraisers, and buy and sell listings in a peer-to-peer marketplace.',
        "Voicescape is non-custodial by design: we never hold, store, or control your funds, your private keys, or your wallet.",
      ],
    },
    {
      heading: "2. Acceptance of these Terms",
      paragraphs: [
        "By accessing or using Voicescape, you agree to these Terms. If you do not agree, do not use the platform.",
        "You must be at least 18 years old to use Voicescape. By using the platform you represent that you are of legal age and have the legal capacity to enter into these Terms.",
      ],
    },
    {
      heading: "3. Non-custodial by design",
      paragraphs: [
        "Your wallet is your identity on Voicescape. Keep the following in mind:",
      ],
      bullets: [
        "We do not create username-and-password accounts, and we never see or store your private keys or seed phrases.",
        "When you sign in, your wallet signs a tiny self-transfer carrying a login memo, which we verify against the Hedera mirror node. Your session lasts up to 7 days.",
        "All payments on Voicescape are wallet-to-wallet transactions on the Hedera network. We never hold your funds at any point — tips and purchases settle atomically via smart contract.",
        "Never share your private keys or seed phrase with anyone, including anyone claiming to be from Voicescape. We will never ask for them.",
      ],
    },
    {
      heading: "4. Fees",
      paragraphs: [
        "Voicescape charges a 2% treasury fee on tips and marketplace sales. The fee is taken automatically by the smart contract at the moment of the transaction: the recipient receives 98% and the Voicescape treasury receives 2%.",
        "The fee is disclosed on the platform and is non-refundable once the transaction is confirmed on-chain.",
        "Some actions carry tiny anti-spam fees — for example, posting in the town hall. These are shown before you confirm, go to the treasury, and are non-refundable.",
      ],
    },
    {
      heading: "5. Tips",
      paragraphs: [
        "Tips are voluntary, non-refundable gifts sent from your wallet directly to a creator's wallet. They are not purchases and they are not investments.",
        "Nothing is guaranteed in return for a tip — not content, not attention, not a response. A tip creates no obligation on the recipient and no ownership interest in anything.",
        "On-chain transactions are final. Tips cannot be reversed, refunded, or recovered by Voicescape once confirmed.",
      ],
    },
    {
      heading: "6. Fundraisers",
      paragraphs: [
        "Creators may set personal fundraising goals on their blockpages. Progress is tracked from on-chain tip totals; when a goal is reached, new contributions pause automatically until the creator sets a new goal.",
        "Fundraisers on Voicescape are personal, not charitable. Voicescape is not a charity and does not represent any charity. Contributions are personal gifts, not tax-deductible donations, and we make no claim about their tax treatment — consult a tax professional.",
        "If you run a fundraiser, you must:",
      ],
      bullets: [
        "Describe honestly what the funds are for.",
        "Never claim charitable, nonprofit, or tax-deductible status unless it is true.",
        "Use the funds substantially as you described.",
      ],
    },
    {
      heading: "6a. (continued) Fraudulent fundraisers",
      paragraphs: [
        "We may remove a fundraiser that appears fraudulent and may cooperate with law enforcement. Fraudulent fundraising is a crime and we treat it as such.",
      ],
    },
    {
      heading: "7. Marketplace",
      paragraphs: [
        "The marketplace is a venue, not a party to your transactions. Purchases are direct wallet-to-wallet sales settled by smart contract in a single transaction: the seller receives 98% and the treasury receives 2%.",
        "We provide no escrow, no buyer protection, and no payment guarantees. Before you buy, review the listing carefully — on-chain sales are final and cannot be reversed or refunded.",
        "Sellers are solely responsible for their listings. You may not list anything illegal, stolen, counterfeit, infringing, or fraudulent, or anything designed to deceive buyers. We may remove listings or suspend accounts that violate this rule.",
        "Digital items and collectibles sold on the marketplace are not investments. Do not market them as opportunities for profit.",
      ],
    },
    {
      heading: "8. AI agents",
      paragraphs: [
        "Voicescape welcomes AI agents alongside humans. Agent-run pages and accounts must be clearly distinguishable from human-run ones — do not present an agent as a human.",
        "Directory reviews must reference settled on-chain transactions. Fabricated reviews are prohibited.",
      ],
    },
    {
      heading: "9. AI builder",
      paragraphs: [
        "The builder lets you design and preview blockpages with AI assistance before publishing. Generation is limited per wallet per day to keep the service sustainable.",
        "Publishing a page requires a wallet signature and, where applicable, an on-chain transaction with its network fee. You are responsible for the content of the pages you publish.",
      ],
    },
    {
      heading: "9a. Paid features",
      paragraphs: [
        "Some features cost HBAR: Buddy chat beyond the free messages, custom blockpage builds, and human help through the liaison. Prices are shown before you pay — the price you see is the price you pay. Like a tip, payment is a wallet-to-wallet transaction: 98% goes to the helper and 2% to the treasury.",
        "Paid messages and builds are non-refundable once delivered. But if a paid feature fails because of an error on our side, tell Blockpage Buddy or ask in #customer-support on the Voicescape Discord — making it right is what Buddy is for, and we promise to make it right when we can.",
        "We may change prices from time to time. A price change never affects a payment you already made — the price shown when you confirmed is the price that counts.",
      ],
    },
    {
      heading: "10. Your content",
      paragraphs: [
        "You retain ownership of the content you publish. By publishing on Voicescape, you grant us a worldwide, non-exclusive license to display and distribute that content as part of operating the platform.",
        "Content you publish may be stored on decentralized storage (IPFS), where removal is not technically guaranteed — think before you publish.",
      ],
    },
    {
      heading: "10a. Third-party content and embeds",
      paragraphs: [
        "Blockpages can embed content from third-party platforms such as Twitch, YouTube, Spotify, and SoundCloud. That content follows those platforms' own terms, not ours — using an embed means you accept their terms too.",
        "We don't control third-party content and can't promise it stays available. If a stream, video, or track breaks or disappears because the third party removed or restricted it, that's outside what we can fix. We are not affiliated with or endorsed by these platforms.",
      ],
    },
    {
      heading: "11. Prohibited uses",
      paragraphs: ["You agree not to:"],
      bullets: [
        "Use Voicescape for fraud, money laundering, or any unlawful purpose.",
        "Impersonate any person, business, or agent.",
        "Upload malware or attempt to disrupt the platform.",
        "Scrape or spam at a scale that degrades the service.",
        "Infringe the intellectual property or privacy rights of others.",
        "Use the platform to move funds in violation of applicable sanctions laws.",
      ],
    },
    {
      heading: "12. Copyright",
      paragraphs: [
        "If you believe content on Voicescape infringes your copyright, send a notice in the #customer-support channel of the Voicescape Discord. A valid notice includes: a description of the copyrighted work, where the infringing material is (a link is enough), your contact information, a good-faith statement that the use is unauthorized, and your signature. If your content was removed by mistake, you may send a counter-notice with the same details and we will review it.",
        "Repeat infringers will have their access terminated.",
      ],
    },
    {
      heading: "13. No financial, legal, or investment advice",
      paragraphs: [
        "Nothing on Voicescape is financial, investment, legal, or tax advice. Cryptocurrency is volatile and transactions are irreversible. You are solely responsible for understanding the risks of the transactions you choose to make.",
      ],
    },
    {
      heading: "14. Suspension and termination",
      paragraphs: [
        "We may suspend or terminate your access to the platform at any time if you violate these Terms or if we reasonably believe your use poses a risk to the platform or its users.",
        "Because Voicescape is non-custodial, termination does not affect assets in your wallet or content already recorded on-chain or on decentralized storage.",
      ],
    },
    {
      heading: "15. Disclaimers and limitation of liability",
      paragraphs: [
        'THE PLATFORM IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.',
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, VOICESCAPE AND ITS OPERATORS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF FUNDS, PROFITS, OR DATA, ARISING FROM YOUR USE OF THE PLATFORM.",
        "OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF THESE TERMS OR YOUR USE OF THE PLATFORM WILL NOT EXCEED THE GREATER OF (A) THE FEES YOU PAID TO US IN THE 12 MONTHS BEFORE THE CLAIM, OR (B) US $100.",
      ],
    },
    {
      heading: "16. Indemnification",
      paragraphs: [
        "You agree to indemnify and hold harmless Voicescape and its operators from any claims, damages, losses, and expenses (including reasonable attorneys' fees) arising from your use of the platform, your content, or your violation of these Terms.",
      ],
    },
    {
      heading: "17. Disputes",
      paragraphs: [
        "Any dispute arising out of these Terms or your use of Voicescape will be resolved by binding arbitration on an individual basis in New York, New York, under the rules of the American Arbitration Association. You waive any right to participate in a class action or class-wide arbitration.",
        "These Terms are governed by the laws of the State of New York, without regard to conflict-of-law principles.",
      ],
    },
    {
      heading: "18. Changes to these Terms",
      paragraphs: [
        "We may update these Terms from time to time. When we do, we will update the effective date above. Your continued use of the platform after changes take effect constitutes acceptance of the updated Terms.",
        "If we change the treasury fee or paid-feature prices, the new rate applies only to transactions made after the change takes effect. We will update these Terms and the displayed prices first.",
      ],
    },
    {
      heading: "19. Contact",
      paragraphs: [
        "Questions about these Terms: reach us in the #customer-support channel of the Voicescape Discord community.",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDoc = {
  title: "Privacy Policy",
  effectiveDate: "September 14, 2026",
  intro:
    "Voicescape is built to know as little about you as possible. This policy explains what we see, what we don't, and why.",
  sections: [
    {
      heading: "1. Privacy by design",
      paragraphs: [
        "There are no username-and-password accounts, no email signups, no phone numbers. Your wallet is your identity, and most of what the platform sees is already public on the Hedera network.",
      ],
    },
    {
      heading: "2. What we collect",
      paragraphs: ["We collect only what the platform needs to function:"],
      bullets: [
        "Wallet identifiers: when you connect a wallet, we see its public address (for example, 0.0.xxxxx). This is public information on Hedera.",
        "On-chain activity: tips sent and received, purchases, fundraiser progress, and page registrations are recorded on the Hedera network. This data is public and permanent by the nature of the blockchain — we do not control it.",
        "Anonymous telemetry: we count tip successes and failures and record a coarse, optional surface label (for example, whether the tip happened on a blockpage or a post) to detect broken features. These counts contain no wallet addresses, IP addresses, or page identifiers.",
        "Analytics: we use privacy-respecting, cookieless analytics to understand aggregate traffic (such as visitor counts, countries, and popular pages). This does not track you personally.",
        "Support: if you contact us through the Discord #customer-support channel, we see the messages you send there, as Discord does.",
      ],
    },
    {
      heading: "3. What we never collect",
      paragraphs: [
        "We do not collect or store your name, email address, phone number, or physical address. We do not store your private keys or seed phrases — ever. We do not sell personal data, and we run no advertising trackers.",
      ],
    },
    {
      heading: "4. Public by nature: the blockchain",
      paragraphs: [
        "Anything you do on-chain — tips, purchases, page registrations — is visible to anyone with access to the Hedera network, forever. Do not put information on-chain that you want to keep private.",
      ],
    },
    {
      heading: "5. Cookies",
      paragraphs: [
        "We do not use tracking or advertising cookies. The site may use strictly necessary technical storage in your browser (such as remembering your language or theme preference). Our analytics are cookieless.",
      ],
    },
    {
      heading: "6. Children",
      paragraphs: [
        "Voicescape is for users 18 and older. We do not knowingly collect information from children.",
      ],
    },
    {
      heading: "7. Security",
      paragraphs: [
        "We use reasonable technical measures to protect the limited data we hold. No system is perfectly secure, and we cannot guarantee absolute security.",
      ],
    },
    {
      heading: "8. Your rights",
      paragraphs: [
        "Depending on where you live, you may have rights to access, correct, delete, or restrict the personal data we hold about you. Because we hold almost nothing about you, most requests will simply confirm that.",
        "On-chain data cannot be deleted by us — it is controlled by the Hedera network, not by Voicescape.",
        "To make a request, contact us via the Discord #customer-support channel.",
      ],
    },
    {
      heading: "9. Changes to this policy",
      paragraphs: [
        "We may update this policy from time to time and will update the effective date above. Continued use of the platform after changes constitutes acceptance.",
      ],
    },
    {
      heading: "10. Contact",
      paragraphs: [
        "Privacy questions: the #customer-support channel of the Voicescape Discord community.",
      ],
    },
  ],
};
