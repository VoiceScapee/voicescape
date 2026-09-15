#!/usr/bin/env python3
"""
Voicescape Telegram bot — onboarding + FAQ for humans and AI agents.

Stdlib only (urllib). Long-polling, no webhook infra needed.

  python3 bot.py          # run
  python3 bot.py --check  # verify token via getMe
  python3 bot.py --once   # process pending updates, exit

The token NEVER goes in this repo, env vars, or logs. It lives in the Secure
Vault as the `custom.telegram` connector and is pulled at runtime through the
approved surrogate exchange (Sentinel/authd swaps the surrogate for the real
token on egress).

Copy rules (Brandon's standing directives):
- Describe Voicescape as "user/AI built blockpages" (never "MySpace-style").
- Honest outreach: "be the first agents" — never claim agent activity that
  isn't there yet.
- Never guess on money/wallet issues or bugs: holding reply + escalation log.
- Keep replies short and human.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import (  # noqa: E402
    DynamicCredentialError,
    dynamic_credential_entry,
    ensure_allowed_url,
)

API = "https://api.telegram.org"
ALLOWED_HOSTS = ["api.telegram.org"]
CREDENTIAL = "custom.telegram"  # Secure Vault connector (BotFather token)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ESCALATION_LOG = os.path.join(BASE_DIR, "escalations.log")
BUDDY_LOG = os.path.join(BASE_DIR, "buddy.log")
OFFSET_FILE = os.path.join(BASE_DIR, ".offset")

# Blockpage Buddy's Agent Kit brain (read-only chain tools). BUDDY_PUBLIC=1
# keeps the labeled wallet-tracking report out of this public bot — per
# Brandon, wallet tracking stays in private chat reports only.
BUDDY_JS = "/home/hatch/workspace/ops/buddy-agentkit/dist/buddy.js"
BUDDY_TIMEOUT = 150
BUDDY_MAX_REPLY = 4000


# The egress proxy pattern-matches the literal `hsurr:` prefix to swap in the
# real token. The surrogate MUST be placed raw (not URL-quoted): quoting turns
# `hsurr:` into `hsurr%3A`, the proxy no longer matches, and the raw surrogate
# leaks to Telegram (which 404s). Verified live 2026-09-14.
_SURROGATE_RE = re.compile(r"^hsurr:[A-Za-z0-9_:.\-]+$")


def _url(method):
    try:
        entry = dynamic_credential_entry(CREDENTIAL)
    except DynamicCredentialError as e:
        print(f"[bot] telegram credential problem: {e}\n"
              "[bot] create the bot with @BotFather, then paste the token "
              "into the Secure Vault card.", file=sys.stderr)
        sys.exit(1)
    surr = str(entry.get("surrogate", ""))
    if not _SURROGATE_RE.match(surr):
        print("[bot] vault returned a malformed surrogate; refusing to call",
              file=sys.stderr)
        sys.exit(1)
    url = f"{API}/bot{surr}/{method}"
    ensure_allowed_url(url, ALLOWED_HOSTS)
    return url

DAPP = "https://voicescape.vercel.app"
AGENTS_JOIN = DAPP + "/agents/join"
DISCORD = "https://discord.gg/2KGzPduUN5"

# ---------------------------------------------------------------- copy

START = (
    "hey, i'm the voicescape bot \U0001F98E\n\n"
    "voicescape is user/ai-built blockpages on hedera \u2014 your own corner "
    "of the internet where fans tip you on-chain and you keep 98% of every tip.\n\n"
    "i can help whether you're a human creator or an ai agent:\n\n"
    "/agents \u2014 onboard your ai agent\n"
    "/humans \u2014 build your blockpage\n"
    "/tips \u2014 how the 98/2 split works\n"
    "/faq \u2014 quick answers\n"
    "/founder \u2014 the story behind this"
)

AGENTS = (
    "ai agents are first-class citizens here \u2014 not an afterthought.\n\n"
    "\u2022 your own hedera wallet = your identity\n"
    "\u2022 an on-chain AGENT label, so everyone can tell you're an agent\n"
    "\u2022 your own blockpage storefront\n"
    "\u2022 listed in the agent directory\n\n"
    "no permission needed, no invite. be one of the first agents on the platform:\n\n"
    + AGENTS_JOIN + "\n\n"
    "bring a wallet and something to say. the rest is on us."
)

HUMANS = (
    "your blockpage, your rules.\n\n"
    "\u2022 design it yourself or with the ai builder \u2014 no wallet needed to preview\n"
    "\u2022 publish with your hedera wallet (hashpack works best)\n"
    "\u2022 anyone can tip you any amount \u2014 you keep 98%\n"
    "\u2022 run a fundraiser with a live on-chain goal bar\n\n"
    "start here: " + DAPP + "\n"
    "talk to real humans: " + DISCORD
)

TIPS = (
    "the 98/2 split happens inside a single on-chain transaction:\n\n"
    "98% \u2192 the creator's wallet\n"
    "2% \u2192 keeps the platform running\n\n"
    "nobody can skim it, and anyone can verify it on-chain. the platform never "
    "holds your money \u2014 tips go straight from tipper to creator.\n\n"
    "hedera fees are a fraction of a cent, so even sub-dollar tips make sense."
)

FEES = (
    "small fees that mean a lot when moving money.\n\n"
    "a hedera transaction costs ~$0.0001. a $1 tip here costs the creator "
    "practically nothing \u2014 the same $1 over stripe loses ~$0.33 to fees.\n\n"
    "that's the whole thesis: transact instantly, globally, for fees so small "
    "they stop mattering."
)

FAQ = (
    "quick answers:\n\n"
    "\u2022 sign in \u2014 hashpack + hedera's official wallet-connect. you sign a "
    "login message, that unlocks a 7-day session. be on mainnet, latest hashpack, "
    "reload if stuck.\n"
    "\u2022 cost \u2014 the app costs nothing to use. tips split 98/2 on-chain.\n"
    "\u2022 your page \u2014 username looks like user-10424063 (your hedera account "
    "id), registered on-chain when you publish. pages live on ipfs.\n"
    "\u2022 ai builder \u2014 5 generations per wallet per day.\n"
    "\u2022 install the app \u2014 android: chrome \u2192 install app. iphone: safari "
    "share \u2192 add to home screen. pc: install icon in the address bar.\n"
    "\u2022 discord \u2014 " + DISCORD + "\n\n"
    "money missing or something broken? tell me and i'll pass it straight to the team."
)

FOUNDER = (
    "voicescape was built by brandon \u2014 started while he was homeless with "
    "nothing but a phone, now sober and building in the open.\n\n"
    "his take: leemon baird said anyone could carve out their piece of cyberspace. "
    "brandon took him literally.\n\n"
    "the mission: if it changes one person's life, it succeeded.\n\n"
    "watch it happen: " + DAPP
)

JOIN = "come hang out \u2014 creators, builders, hedera folks:\n" + DISCORD
DAPP_MSG = "the app lives here:\n" + DAPP

HOLDING = (
    "that's beyond what i can answer \u2014 i've passed it to the team and "
    "they'll pick it up. if it's about money, the discord #customer-support "
    "channel is fastest:\n" + DISCORD
)

UNKNOWN = (
    "not sure on that one \u2014 i've passed it to the team. "
    "try /faq for the quick answers, or ask in discord:\n" + DISCORD
)

KEYBOARD = {
    "keyboard": [["/agents", "/humans"], ["/tips", "/faq"], ["/founder", "/join"]],
    "resize_keyboard": True,
}

COMMANDS = {
    "start": (START, True),
    "agents": (AGENTS, False),
    "humans": (HUMANS, False),
    "tips": (TIPS, False),
    "fees": (FEES, False),
    "faq": (FAQ, False),
    "founder": (FOUNDER, False),
    "join": (JOIN, False),
    "dapp": (DAPP_MSG, False),
    "app": (DAPP_MSG, False),
}

# Escalate first: money trouble, hacks, anything the bot must not guess on.
ESCALATE_KEYWORDS = [
    "didn't arrive", "did not arrive", "not arrived", "never arrived",
    "missing", "lost", "stuck", "failed", "not showing up", "didn't show",
    "did not show", "scam", "hacked", "drained", "stolen", "refund",
    "bug", "broken", "error", "not working",
]

# (keywords, reply) — checked after escalation triggers.
FAQ_KEYWORDS = [
    (["hashpack", "wallet", "sign in", "signin", "log in", "login", "session",
      "connect wallet"],
     "sign in with hashpack via hedera's official wallet-connect. you sign a "
     "login message proving you own the wallet \u2014 that unlocks a 7-day session "
     "for the builder and all write features.\n\nstuck? latest hashpack, hedera "
     "mainnet (not testnet), then reload the page."),
    (["agent"],
     "ai agents get their own lane: hedera wallet identity, on-chain AGENT label, "
     "blockpage storefront, directory listing. details: /agents"),
    (["directory"],
     "the agent directory lists onboarded agents by capability \u2014 "
     "machine-readable and human-browsable. onboard yours: " + AGENTS_JOIN),
    (["install", "pwa", "iphone", "android", "home screen"],
     "install the app: android \u2014 chrome \u2192 install app. "
     "iphone \u2014 safari share \u2192 add to home screen. "
     "pc \u2014 install icon in the address bar. no app store, free."),
    (["page", "blockpage", "username", "publish", "builder"],
     "your page username looks like user-10424063 (your hedera account id), "
     "registered on-chain when you publish. pages are stored on ipfs. the ai "
     "builder caps at 5 generations per wallet per day. design free at " + DAPP),
    (["fee", "fees", "cost", "how much", "2%", "98"],
     "tips split 98/2 inside one on-chain transaction \u2014 98% to the creator, "
     "2% to the platform, enforced atomically. hedera fees are a fraction of a "
     "cent. more: /tips"),
    (["tip", "tipping", "donate", "donation", "fundraiser", "goal"],
     "anyone can tip any amount on-chain \u2014 sub-dollar tips work. creators "
     "keep 98%. fundraisers get a live on-chain goal bar. more: /tips"),
    (["founder", "brandon", "story", "who made", "who built"],
     FOUNDER),
    (["discord", "community", "server"],
     JOIN),
    (["hedera", "hbar"],
     "built on hedera mainnet \u2014 fast, tiny fees, and the 98/2 split enforced "
     "on-chain. more: /fees"),
]

# ---------------------------------------------------------------- api

def api_call(method, params=None, timeout=40):
    url = _url(method)
    data = None
    if params:
        data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except Exception as e:  # noqa: BLE001 - log and keep polling
        print(f"[bot] api error on {method}: {e}", flush=True)
        return None


def send_message(chat_id, text, with_keyboard=False):
    params = {"chat_id": chat_id, "text": text,
              "disable_web_page_preview": True}
    if with_keyboard:
        params["reply_markup"] = json.dumps(KEYBOARD)
    res = api_call("sendMessage", params)
    if res and not res.get("ok"):
        print(f"[bot] sendMessage failed: {res}", flush=True)


def log_escalation(chat, text):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "chat_id": chat.get("id"),
        "username": chat.get("username"),
        "first_name": chat.get("first_name"),
        "text": text[:500],
    }
    with open(ESCALATION_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"[bot] ESCALATED from @{entry['username']}: {text[:80]}", flush=True)


def log_buddy(chat, question, reply):
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "chat_id": chat.get("id"),
        "username": chat.get("username"),
        "question": question[:500],
        "reply": (reply or "")[:500],
    }
    with open(BUDDY_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def _clean_buddy_reply(text):
    # Buddy sometimes emits markdown; this bot sends plain text.
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = text.replace("`", "")
    return text.strip()[:BUDDY_MAX_REPLY].strip()


def ask_buddy(text):
    """Ask Blockpage Buddy's Agent Kit brain. Returns reply text or None."""
    question = text.strip()[:2000]
    if not question:
        return None
    env = dict(os.environ)
    env["BUDDY_PUBLIC"] = "1"
    try:
        proc = subprocess.run(
            ["node", BUDDY_JS, question],
            env=env,
            capture_output=True,
            text=True,
            timeout=BUDDY_TIMEOUT,
        )
    except Exception as e:  # noqa: BLE001 - timeouts, missing node, etc.
        print(f"[bot] buddy call failed: {e}", flush=True)
        return None
    reply = (proc.stdout or "").strip()
    if proc.returncode != 0 or not reply:
        print(f"[bot] buddy error rc={proc.returncode}: "
              f"{(proc.stderr or '')[:200]}", flush=True)
        return None
    return _clean_buddy_reply(reply)


# ---------------------------------------------------------------- routing

_last_reply = {}

# Questions that want a live on-chain fact go to Buddy first — the keyword
# FAQ can't answer "is X registered?" or "did my tip settle?".
ONCHAIN_HINTS = [
    "registered", "owner", "owns", "transaction", "verify", "settled",
    "treasury", "go through", "did my tip",
]
_ACCOUNT_RE = re.compile(r"0\.0\.\d+")


def _looks_onchain(lowered):
    return _ACCOUNT_RE.search(lowered) is not None or any(
        h in lowered for h in ONCHAIN_HINTS)


def _try_buddy(chat, chat_id, text):
    """Send Buddy's reply. Returns True if he answered."""
    reply = ask_buddy(text)
    if reply:
        log_buddy(chat, text, reply)
        send_message(chat_id, reply)
        return True
    return False


def handle_text(chat, text):
    chat_id = chat["id"]
    now = time.time()
    if now - _last_reply.get(chat_id, 0) < 2:  # per-chat cooldown, anti-loop
        return
    _last_reply[chat_id] = now

    lowered = text.strip().lower()

    # Commands (also handle /cmd@botname in groups).
    if lowered.startswith("/"):
        cmd = lowered[1:].split()[0].split("@")[0]
        if cmd in COMMANDS:
            reply, with_keyboard = COMMANDS[cmd]
            send_message(chat_id, reply, with_keyboard)
            return
        send_message(chat_id, UNKNOWN)
        return

    # Never guess on money/wallet trouble or bugs — escalate.
    if any(k in lowered for k in ESCALATE_KEYWORDS):
        log_escalation(chat, text)
        send_message(chat_id, HOLDING)
        return

    # On-chain fact questions go to Buddy's Agent Kit brain first.
    if _looks_onchain(lowered):
        if _try_buddy(chat, chat_id, text):
            return

    # Keyword FAQ.
    for keywords, reply in FAQ_KEYWORDS:
        if any(k in lowered for k in keywords):
            send_message(chat_id, reply)
            return

    # Anything else goes to Blockpage Buddy (Agent Kit brain, read-only
    # chain tools). If Buddy can't answer, fall back to the old path:
    # say so, log it for the team, don't invent.
    if _try_buddy(chat, chat_id, text):
        return
    log_escalation(chat, text)
    send_message(chat_id, UNKNOWN)


def process_updates(offset, timeout=30):
    res = api_call("getUpdates", {"offset": offset, "timeout": timeout,
                                  "allowed_updates": ["message"]},
                   timeout=timeout + 15)
    if not res or not res.get("ok"):
        return offset
    for update in res["result"]:
        offset = max(offset, update["update_id"] + 1)
        msg = update.get("message")
        if not msg:
            continue
        sender = msg.get("from", {})
        if sender.get("is_bot"):
            continue
        text = msg.get("text", "").strip()
        if not text:
            continue
        print(f"[bot] msg from @{sender.get('username')}: {text[:60]}",
              flush=True)
        try:
            handle_text(msg["chat"], text)
        except Exception as e:  # noqa: BLE001 - never let one message kill the loop
            print(f"[bot] handler error: {e}", flush=True)
    return offset


def _load_offset():
    try:
        with open(OFFSET_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 0


def _save_offset(offset):
    with open(OFFSET_FILE, "w") as f:
        f.write(str(offset))


def main():
    me = api_call("getMe", timeout=15)  # also proves the vault credential works
    if not me or not me.get("ok"):
        print(f"[bot] token check failed: {me}", file=sys.stderr)
        sys.exit(1)
    bot_name = me["result"].get("username", "?")
    print(f"[bot] live as @{bot_name}", flush=True)

    if "--check" in sys.argv:
        return

    # Drain pending updates and exit (for cron). Offset persists in .offset
    # so each update is answered exactly once across runs.
    if "--once" in sys.argv:
        offset = _load_offset()
        offset = process_updates(offset, timeout=10)
        _save_offset(offset)
        return

    print("[bot] polling...", flush=True)
    offset = _load_offset()
    while True:
        try:
            offset = process_updates(offset)
            _save_offset(offset)
        except Exception as e:  # noqa: BLE001
            print(f"[bot] poll loop error: {e}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    main()
