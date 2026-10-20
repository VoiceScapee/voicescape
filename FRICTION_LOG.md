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

---

## Entries in the hackathon's required format

### iPhone mic
- **Task:** Let iPhone users drive the voice demo by mic.
- **Steps:** Built the mic flow on the Web Speech API; tested on iPhone Safari, then Chrome and Firefox on iOS.
- **Expected:** Mic works like it does on desktop.
- **Actual:** Recognition is flaky on iOS, and every iOS browser uses WebKit, so switching browsers doesn't help.
- **Severity:** Medium \u2014 the iPhone is my own device and a big share of judges.
- **Workaround:** The demo detects iOS and says so plainly under the mic; typing and the keyboard dictation key are first-class and run the exact same agent pipeline, and the agent still talks back out loud.
- **Suggestion:** Per-platform mic reliability notes in the Web Speech API docs, or a capability-detection API instead of user-agent sniffing.

### Silent Vercel deploy rejection
- **Task:** Ship the demo to a Vercel preview.
- **Steps:** Pushed the branch; the dashboard showed no deployment at all; deploy hooks returned PENDING and created nothing; disconnected and reconnected the Git integration.
- **Expected:** A failed deploy shows as failed, with a reason.
- **Actual:** The Hobby plan rejects deployment creation with HTTP 400 cron_jobs_limits_reached (vercel.json had an hourly cron); nothing is ever recorded, so the dashboard just looks dead.
- **Severity:** High \u2014 lost a full day root-causing it.
- **Workaround:** Diagnosed through the Vercel REST API, which returns the real 400 + error code; moved the cron to daily-or-slower.
- **Suggestion:** Surface the cron-limit rejection in the dashboard as a failed deployment with the reason, instead of silently creating nothing.

### Wallet testing in automated QA
- **Task:** Cover wallet connect and sign flows in automated QA.
- **Steps:** Tried installing the HashPack/Blade wallet extensions in the automation Chromium.
- **Expected:** Extensions install like they do in real Chrome.
- **Actual:** Web Store installs hang forever on "Processing item install" in automated Chromium, and extension pages are unreachable \u2014 no wallet can connect in automation.
- **Severity:** Medium \u2014 money-moving flows can't be covered by CI.
- **Workaround:** Verified the tip dialog UI itself in automation (opens, correct 98/2 math, wallet-connect prompt); real signing is tested on my phone.
- **Suggestion:** A documented headless-friendly wallet test harness, or official guidance for dapp CI.
