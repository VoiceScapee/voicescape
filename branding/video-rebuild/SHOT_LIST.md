# Screenshot capture spec — Voicescape video rebuild (2026-09-15)

Capture FRESH screenshots of the **live** site https://voicescape.vercel.app via the
live browser. The videos currently in `branding/` were built from 2026-09-14
screenshots (old hero, empty agent directory, pre-Buddy-rebrand copy) — that is
what Brandon flagged.

## Gate before capturing

1. Confirm the site is serving the latest deploys (spot-check the landing hero —
   it must read **"Build your page in minutes. Keep 98% of every tip."**).
2. **/forge MUST be captured AFTER the 2026-09-15 on-chain update is live.**
   Verify: `GET https://voicescape.vercel.app/api/resolve?username=forge`
   must return `"ipfsHash":"QmSME2ZuXZoptvhxxmicGnmn9VhTDkZXw7dV1VG35vDU64"`.
   (Confirmed live 2026-09-15 ~13:47 EDT. If it returns a different CID, wait —
   do not capture stale copy.)

## Capture rules

- Viewport **1280×720**, deviceScaleFactor 1. (Larger is fine — the build scales.)
- No wallet connection, no sign-in, no form submissions. Public views only.
- Wait for each page/section to fully render before capturing.
- Scroll the page so the target section fills the viewport.
- Save as PNG into `branding/video-rebuild/shots/` with the exact filenames below.

## Shots (7 required)

| # | File | URL | What must be visible |
|---|------|-----|----------------------|
| 1 | `shot-landing-hero.png` | `/` | Top of landing: the NEW 98% hero ("Build your page in minutes. Keep 98% of every tip." / "Carve out your piece of cyberspace") |
| 2 | `shot-founder-page.png` | `/user-10424063` | Top of Brandon's blockpage: profile header, founder badge |
| 3 | `shot-founder-tips.png` | `/user-10424063` | Scrolled to the tip jar / fundraiser section ("Tip this page") |
| 4 | `shot-agents.png` | `/agents` | Agent Directory **with danny + echo listed** (old video showed "No agents registered yet" — must NOT show that) |
| 5 | `shot-builder.png` | `/builder` | Builder in preview mode (no wallet), template/block preview visible |
| 6 | `shot-townhall.png` | `/chat` | Town Hall lobby: Live Chat rooms (Lobby, Builders) |
| 7 | `shot-forge-buddy.png` | `/forge` | **Blockpage Buddy page top, POST-UPDATE copy** — hero subtitle must read "Your blockchain buddy, built on Hedera's agent toolkit. I help you build." and the bio must lead with "Blockpage Buddy is your blockchain buddy — an AI builder agent with an on-chain AGENT identity on Hedera, built on Hedera's official agent tooling (Hiero SDK + HCS-10)." If the old copy shows, the update hasn't propagated — wait and re-capture. |

## After capture

Run `./build.sh` in `branding/video-rebuild/`. It assembles:
- `voicescape-demo-video.mp4` (46.8s, 6 Ken Burns segments, original narration)
- `voicescape-hype-v2.mp4` (66.5s, 6 captioned Ken Burns segments + original end card, original narration)
- `voicescape-hype-v2-vertical.mp4` (720×1280 blurred-bg cut of the 16:9)

Then ffprobe-verify and commit the three MP4s. Do NOT upload to YouTube and do
NOT post to X (both are on hold per Brandon).
