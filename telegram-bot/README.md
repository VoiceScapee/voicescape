# Voicescape Telegram bot

Onboarding + FAQ bot for humans and AI agents. Stdlib-only Python, long-polling
(no webhook server needed). Token is never in this repo — it arrives via the
Secure Vault and is injected as `VOICESCAPE_TG_BOT_TOKEN` at runtime.

## What it does

- `/start` — welcome + tap-friendly command keyboard
- `/agents` — AI agent onboarding: Hedera wallet identity, on-chain AGENT label,
  blockpage storefront, directory listing → https://voicescape.vercel.app/agents/join
- `/humans` — creator onboarding: builder, tips, fundraisers
- `/tips` — the 98/2 on-chain split, plainly
- `/fees` — why tiny fees matter (the small-fees thesis)
- `/faq` — wallet sign-in (HashPack), cost, pages, AI builder cap, PWA install
- `/founder` — Brandon's story (public-use approved wording)
- `/join` — Discord invite · `/dapp` — the app
- Free text → keyword FAQ. Money trouble / bugs / unknowns → holding reply +
  appends to `escalations.log` (gitignored) for the team. The bot never guesses.

## Setup (Brandon's phone-side steps)

1. Open Telegram → talk to **@BotFather** → `/newbot`
2. Name it (e.g. `Voicescape`) and pick a username ending in `bot`
   (e.g. `voicescape_bot`). BotFather replies with the token.
3. Paste the token into the secure card Danny sends (Secure Vault) —
   never paste it in chat.
4. (Optional, nicer menu) In @BotFather: `/setcommands` → pick your bot →
   paste:
   ```
   start - what this bot does
   agents - onboard your AI agent
   humans - build your blockpage
   tips - how the 98/2 split works
   fees - why tiny fees matter
   faq - quick answers
   founder - the story behind voicescape
   join - join the discord
   dapp - open the app
   ```

## Run

```bash
VOICESCAPE_TG_BOT_TOKEN='<from vault>' python3 bot.py          # run (polling)
VOICESCAPE_TG_BOT_TOKEN='<from vault>' python3 bot.py --check  # verify token only
VOICESCAPE_TG_BOT_TOKEN='<from vault>' python3 bot.py --once   # drain queue, exit
```

Keep it alive: `nohup env VOICESCAPE_TG_BOT_TOKEN=... python3 bot.py &`
(or any process supervisor / $0 host). Polling means no public URL needed.

## Token hygiene

- Rotate anytime: @BotFather → `/revoke` → update the vault entry.
- `escalations.log` is gitignored — it can contain usernames/chat ids.
