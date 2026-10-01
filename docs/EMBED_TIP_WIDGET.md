# Embeddable tip widget

Any creator can paste a "tip me" button on an external site (Carrd, a blog, a
link-in-bio page that supports HTML embeds). Visitors tip without leaving the
creator's site. Tips settle through the standard on-chain flow — `tipPage` on
the Tips contract, 98% to the creator / 2% treasury, enforced on-chain. No new
payment logic, no new services, no new keys.

## For creators (plain language)

1. Open **https://voicescape.vercel.app/embed** (also linked in the nav under Create → "Embed a tip button").
2. Type your Voicescape username (the same name as your blockpage).
3. Optionally pick a suggested tip amount.
4. Copy the code and paste it where your site lets you add HTML (e.g. a Carrd "Embed" element).

The button opens the visitor's wallet inside the frame. The embedding site
cannot see the visitor's wallet or their Voicescape session (cross-origin
iframe). Works on phones and desktops.

## Snippet

```html
<iframe src="https://voicescape.vercel.app/embed/tip/{username}" width="320" height="480" style="border:0;border-radius:16px;max-width:100%;" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" title="Tip @{username} on Voicescape"></iframe>
```

Replace `{username}` with the creator's registry username (lowercase,
`a-z0-9-`, 3–24 chars — e.g. `bacon-the-dino`, `user-10424063`).

## URL params

| Param    | Example            | Effect                                              |
|----------|--------------------|-----------------------------------------------------|
| `amount` | `?amount=10`       | Preselects a USD tip amount in the widget (1–1000; out-of-range values are ignored). Display default only — the visitor can still change it. |

Unknown usernames render an honest "we couldn't find @name" state — never
fake content, nothing is charged.

## For developers

- Widget route: `frontend/app/embed/tip/[username]/page.tsx` (server wrapper +
  `EmbedTipWidget.tsx` client component). Standalone: own wallet connect,
  resolves the username via the existing `resolvePage` registry lookup.
- Creator page: `frontend/app/embed/page.tsx` with live preview.
- Snippet/URL builders: `frontend/lib/embed.ts` (pure, tested in
  `frontend/lib/embed.test.ts`).
- The tip UI is the shared `frontend/components/TipModal.tsx` — the exact
  component town-hall posts use, extracted verbatim from
  `components/townhall/PostCard.tsx` (which now imports it). The only
  additions are display-only props: `inline` (bare panel, no overlay chrome)
  and `initialAmount` (preselected amount). No payment/wallet/fee/contract
  logic was changed.
- Clickjacking: `frontend/next.config.js` sets
  `Content-Security-Policy: frame-ancestors *` on `/embed/:path*` only — the
  widget is meant to be framed; the rest of the app is untouched.
- `components/AgentChat.tsx` returns null when framed (`window.self !==
  window.top`) so the Buddy button never floats over someone else's embed.
- The widget page sets `robots: noindex` — it's for framing, not search.
