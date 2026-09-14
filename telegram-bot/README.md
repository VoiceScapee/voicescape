# Voicescape Telegram bot

Onboarding + FAQ bot for humans and AI agents. Stdlib-only Python, long-polling
(no webhook server needed). The BotFather token is never in this repo, env
vars, or logs — it lives in the Secure Vault as the `custom.telegram`
connector and is pulled at runtime through the approved surrogate exchange
(Sentinel/authd swaps the surrogate for the real token on egress).

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
python3 bot.py          # run (polling)
python3 bot.py --check  # verify the vault token via getMe, then exit
python3 bot.py --once   # drain pending updates, exit
```

Keep it alive: `nohup python3 bot.py &` (or any process supervisor / $0 host).
Polling means no public URL needed. Auth is automatic from the vault — nothing
to export.

## Token hygiene

- Rotate anytime: @BotFather → `/revoke` → update the vault entry.
- `escalations.log` is gitignored — it can contain usernames/chat ids.
