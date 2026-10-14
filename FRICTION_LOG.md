# Friction Log — Voicescape Voice Builder (DRAFT for Brandon's edit)

**Amazon Build, Ship, Shape — Alexa+ track.** What actually broke, what we did about it, what we'd change. Written for the Devpost friction-log field (up to 10% judging bonus).

---

## 1. iPhone Safari's microphone is unreliable — we stopped pretending otherwise

**Friction:** iOS exposes the Web Speech API, but recognition is flaky across iOS browsers (all iOS browsers use WebKit under the hood, so Chrome/Firefox on iPhone don't fix it). Our first version just showed the mic and hoped.

**Fix:** The demo now detects iOS and says so plainly under the mic: the browser mic can be flaky — use the keyboard's dictation key or just type; the agent talks back out loud either way. Typed and dictated prompts run the exact same agent pipeline, so nothing is lost.

**Would change:** A real cross-browser transcription fallback needs a server-side speech service, which means new cost and new keys. For a $0 demo we chose honesty over a half-working mic. If we had budget, we'd add a streaming transcription endpoint and keep the browser mic as the progressive enhancement, not the only path.

## 2. Vercel preview protection ate our images

**Friction:** Our shareable judge link uses Vercel's protection-bypass token. The page HTML loaded fine, but subresource requests (logos) intermittently 404'd against the auth wall before the bypass cookie landed — the brand marks showed as broken images on some loads.

**Fix:** Inlined both logos as data URIs directly in the page. They now render on every load, no network race.

**Would change:** Nothing — inlining is the right call for a demo page. For production we'd serve from the same origin behind the same protection and set cache headers properly.

## 3. Branch deploys went slow on demo night

**Friction:** Vercel took ~20 minutes to deploy a branch push the night we were polishing (normally 1–3). We verified what was actually live by curling the deployed HTML and grepping for our markers rather than assuming the push had landed.

**Fix/learning:** Never tell the founder "it's live" from a push — verify the deployed bytes. We now check the live page for expected strings before reporting.

## 4. Automated visual QA couldn't do mobile viewports

**Friction:** Our browser QA tooling has no viewport-resize capability, so the 390px iPhone layout couldn't be verified by automation at all — and its clicks on the tools-modal button didn't reproduce what real phones do.

**Fix:** Desktop QA caught real issues (broken images, tap-target sizes); the physical phone check stayed with the founder, who caught the small-logo problem automation never would have. Both halves were necessary.

**Would change:** We'd add a real device-farm screenshot pass (e.g. BrowserStack) before recording the demo video, so the phone layout is verified by pixels, not just by hand.

## 5. Speech synthesis voices differ per device

**Friction:** The "agent talks back" feature sounds different on every phone and PC — voice availability is entirely up to the OS/browser. We don't control it.

**Fix:** We never promise a specific voice. The copy says "the agent talks back out loud" — true everywhere, identical nowhere, and that's fine.

---

*Brandon: edit in your voice before pasting into Devpost. Nothing here is invented — it's all from the build nights.*
