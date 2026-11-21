# Spec pin — Open Agentic Web Challenge (frozen spec)

**Date pinned:** 2026-11-21 · **Branch:** `danny/open-agentic-web-entry` · **Status:** research record for the week-2 build.

## Why this pin exists

The Official Rules (§4) freeze the spec **"as of the start of the Submission Period"**.
The submission period started **Nov 11, 2026, 8:00pm PT = Nov 12, 2026, 04:00 UTC**.
The spec repo README warns it "is actively evolving and its content changes frequently",
so the entry must conform to the Nov 11 snapshot, not to whatever `main` says at submit time.
If rules and spec disagree, the Official Rules prevail (Rules §11.4).

## Pinned commit

| Field | Value |
|---|---|
| Commit | `e4a8727d5c6807233b8976f28494bbdac7bc1c6e` |
| Message | Merge pull request #7 from cognizant-ai-labs/worktree-agentify-website-skill |
| Committer date | 2026-11-11 19:57:53 -0800 (2 min 07 s before the 8:00pm PT freeze) |
| Next commit (after freeze) | `65a89a74f5f56f48338407db7e532dd8b89340ec`, 2026-11-11 20:52:46 -0800, "Simplify pizza restaurant agent instructions" |
| Spec version at pin | **MVP Profile 0.2, 6 November 2026** (`docs/worldwide_agentic_web_mvp_spec.md` line 5) |
| Repo | https://github.com/cognizant-ai-labs/agentic-web |

## How the pin was resolved

The earlier research clone (`/tmp/agentic-web-spec`) was shallow (depth 1), which is why
the Nov 11 commit could not be verified from the commits page. Fix: `git fetch --unshallow`
(143 commits), then `git log --before="2026-11-12 04:00:00 +0000"` / `--after` on
**committer dates** (the `--before`/`--after` filters use committer date; author dates on
some commits in this window differ by hours, so author-date filtering would misplace the
boundary). The boundary is clean: `e4a8727` is the last commit at/before the freeze on
committer date, and the next commit is 52 minutes after it.

Reproduce:

```shell
git clone https://github.com/cognizant-ai-labs/agentic-web.git
git checkout e4a8727d5c6807233b8976f28494bbdac7bc1c6e
```

A reference copy of the pinned tree (spec doc, agentify skill, providers, quickstart,
agentic-websites list) is vendored in this branch at `docs/agentic-web/pinned-spec/`.
Week 2 builds from **that copy**, not from spec `main`.

## 0.2 vs 0.3 — what actually changed

MVP Profile 0.3 (18 November 2026) first appears in commit `a0ceda34`
("Fix broken links and typos in spec", 2026-11-18). The diff of the spec document
between the pin and `main` (`f154be8f`, 2026-11-20) is **5 lines changed, all
non-substantive**:

1. Version line: `MVP Profile 0.2 | 6 November 2026` → `MVP Profile 0.3 | 18 November 2026`.
2. "Portable network" table row: SharePoint link to the Neuro SAN HOCON doc → GitHub link
   (`cognizant-ai-lab/neuro-san/.../agent_hocon_reference.md`).
3. Typo fix: "MAYautomate" → "MAY automate".
4. Typo fix: "Result return: Result return:" → "Result return:".
5. "Pluggable inference" row: SharePoint router link → `docs/providers/providers.md`.

Conformance substance is identical between 0.2 and 0.3. The version bump is editorial.
Building to 0.2 (the frozen version) does not lose anything 0.3 adds.

## CORRECTION to the win plan — runtime commit

The win plan (§2, artifact 4) cited the browser runtime as "nsdeploy runtime at commit
`53a787c` (2026-11-11)". That is **wrong for the frozen spec**: `53a787c` is what the
runtime README cites at spec `main` (Nov 20). At the pin, `skills/agentify-website/runtime/README.md`
line 7 cites nsdeploy commit **`23df164` (2026-11-10)**. Week 2 must vendor the **pinned
runtime** (the `runtime/` files at `e4a8727`, in `docs/agentic-web/pinned-spec/agentify-website/runtime/`),
not the HEAD runtime. The pinned runtime is an edited copy of nsdeploy's browser runtime
(Apache 2.0, `LICENSE.txt` kept); nsdeploy itself is at https://github.com/cognizant-ai-lab/nsdeploy.

## Skill drift after the freeze

The agentify skill itself changed substantially between the pin and `main`:
35 files, +5,097 / −437 lines (`git diff --stat e4a8727 f154be8f -- skills/`), including
`templates/site.js` and the `templates/tests/` suite. The pinned skill in
`docs/agentic-web/pinned-spec/agentify-website/` is the build reference. If a week-2
step in the HEAD skill contradicts the pinned skill, the pinned skill wins; record any
such conflict in the build log rather than silently taking the newer text.
