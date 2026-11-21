---
name: agentify-website
description: Turn an existing website into an open agentic website. Inventory the site's data and operations, design a small grounded Neuro SAN agent network, expose the site's own functions as website_* tools, embed the browser runtime with a BYOK chat, and verify it with Node tests. Use when asked to agentify a website, add an assistant or chat agent to a site, or create an agent network from a website, given a local site folder or a public URL.
---

# Agentify a website

This skill turns a website into an open agentic website, as defined in the
[Worldwide Agentic Web MVP spec](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md).
The result is a copy of the site with an assistant embedded in the page. The assistant
runs in the visitor's browser, uses the visitor's own LLM key, answers from the site's
real data, and calls the site's own functions to act.

## What you need

- **The site.** A local folder with its HTML, CSS and JavaScript (source mode), or a
  public URL (live URL mode, see `references/live_url_mode.md`).
- **Node.js 22 or newer**, for the build script and the tests.
- **Python 3**, or another static file server, to serve the site for the browser check.

The browser runtime is in this skill's `runtime/` folder. It is nsdeploy's runtime with
edits that let agents call the site's functions, which nsdeploy's own runtime cannot do
yet. Do not install or run nsdeploy, and do not replace this copy.

In the commands below, `SKILL_DIR` is the folder that contains this file.

## Workflow

### 1. Inventory the site

Read every page and script. Fill in the inventory table from
`references/network_design.md`: data, state, operations (with whether the visitor can undo
them), what the site does not support, and external services. Note the file and line
for each item.

For a public URL without source, follow `references/live_url_mode.md` first.

**Checkpoint.** Show the user the inventory and the proposed design (agents, tools,
the effect of each action, and the "not supported" list) and ask them to confirm. Pay
attention to which actions are `irreversible`, since `read` and `write` tools run without
a dialog. Skip the checkpoint only if the user said to proceed without asking.

### 2. Design the network

Follow `references/network_design.md`. The defaults are:

- one front agent that owns all `website_*` tools; add a specialist only for separate
  knowledge, a separate system, or a separate workflow;
- plain delegation with a `request` parameter, not AAOSA;
- no `demo_mode`; facts only from tool results; a list of what the site cannot do;
- shared rules in `commondefs.replacement_strings`, with CRUSE rules on the front agent only;
- sample queries the site can really answer, plus one it must decline.

### 3. Copy the site and the runtime

```shell
cp -R <site> <out>
cp -R SKILL_DIR/runtime <out>/runtime
```

Pick `<out>` with the user. The default is a sibling folder named `<site>_agentified`.
If `<out>` already exists, ask the user whether to delete it or pick another folder.
Do not copy into it: `cp -R` puts the new copy inside it and keeps the old files.
Never change the original site or the runtime files. If the copy has a README, update its
run command and file list for the agentified version before you finish.

### 4. Expose the site's operations

Follow `references/site_actions.md`:

1. Make the page script a module that exports its page object, such as a static
   `App.page`, with a state reader and one method per operation. Make the page's own
   buttons and forms call those same methods. An operation refuses bad input by returning
   `{ok: false, reason}` without changing anything; a thrown error is reported to the
   agent as "unknown outcome".
2. Give each irreversible operation one read-only check that it calls first. Add a
   version counter if it acts on page state that is not in its arguments, such as a
   cart. If an amount the visitor agrees to can change by itself, such as a fee that
   depends on today's date, also pass the amount they saw and refuse a mismatch, unless
   the site already does.
3. Write `<out>/site-actions.js` from `templates/site-actions.js`.

### 5. Write the network and the manifest

Copy `templates/network.hocon` to `<out>/<network>.hocon`, and
`templates/agent-manifest.json` and `templates/links.json` to `<out>/`. Replace every
`<...>` and `TODO`. The network name is the `.hocon` file name and must be the same
everywhere. Use the protocol name in `runtime/README.md` for `<protocol_name>`. Then build:

```shell
node SKILL_DIR/scripts/build_network.mjs <out>/<network>.hocon --manifest <out>/agent-manifest.json
```

This writes `<out>/<network>.network.json` with the runtime's own parser, runs the
runtime's validator, and checks for leftover `<...>` and `TODO` markers, demo mode, AAOSA,
agents nothing can call, agents with no model, oversized instructions, unsupported tools,
unused or unlisted `website_*` tools, and manifest mismatches. It also writes the
discovery files, which copy parts of the manifest: `agent-mcp.json`,
`.well-known/<protocol_name>.json` and `.well-known/<protocol_name>-agent.json`. It prints
the tools the runtime adds to every agent, which the `tools` lists do not show. Fix every
error. Fix the warnings too, or tell the user why one stays. Never edit generated files by
hand: change the `.hocon` or the manifest and rebuild.

### 6. Mount the assistant

Follow `references/bundle_and_hosting.md`:

1. Add `templates/assistant-section.html` to the page, with its heading and sentence
   filled in, and `templates/assistant.css` to its stylesheet. Set the `--ns-*` colors
   and `theme.primary` to the site's palette. White text sits on `--ns-primary` and
   `--ns-accent`, so keep both dark enough.
2. Copy `templates/site.js` to `<out>/site.js` and load it with `<script type="module">`.
   Write a `GREETING`, and fill in `DIALOGS` for each `irreversible` action. Name the
   buttons after what they do, such as "Keep the booking", not "Cancel". Give
   `reviewDetails` the real details, such as items, total, name and email, and what
   undoing it would cost, such as a cancellation fee. The dialog opens before the
   operation runs, so `reviewDetails` also calls the operation's read-only check. When
   it refuses, return `{refusal: reason}`: no dialog opens, and the agent gets the
   site's reason.
3. The page must still work when the assistant fails to boot.

### 7. Test

Copy `templates/tests/` to `<out>/tests/`, fill in the TODOs, and add the tests in "Test
every action" in `references/site_actions.md`. Then run:

```shell
node SKILL_DIR/scripts/build_network.mjs <out>/<network>.hocon --manifest <out>/agent-manifest.json --check
node --test "<out>/tests/*.test.mjs"
```

Quote the glob. Node 22 does not accept a bare folder after `--test`.

Then serve the site with `python3 -m http.server 8080 --bind 127.0.0.1 --directory <out>`
(on Windows, `python`). To check a chat form, a choice list and the confirmation dialog
without a key, use the console check in "Check without a key" in
`references/bundle_and_hosting.md`.

If the user wants a live check, ask them to enter their own key in the BYOK panel and try
each sample query. Never ask the user to paste a key into the chat. On `localhost` and
`127.0.0.1`, the runtime also saves keys in a cookie that any local site can read, so
suggest a key with a low spending limit. Afterwards, they should delete the saved setup
and close the tab: the tab keeps using the key until it is closed (see "Serving and trying
it" in `references/bundle_and_hosting.md`).

### 8. Report

Tell the user:

- where the output is and how to run it;
- where the site can be listed once it is hosted (see "How others find the site" in
  `references/bundle_and_hosting.md`);
- the headers to set when it is hosted, with the real file names (see "Static hosting"
  in `references/bundle_and_hosting.md`);
- the network (agents and their tools) and the actions (name, effect, wrapped function);
- what the assistant can answer and do, and what it declines;
- the exact test commands and their results;
- the limits: static hosting only; the runtime is a patched copy of nsdeploy's; `write`
  actions run without showing the visitor first, which the spec does not allow; every
  agent can see every `website_*` tool; other agent sites cannot call this network yet,
  and it does not call theirs; the LLM provider must allow CORS; the network file,
  including instructions, is public.

## Rules

- Never fabricate. No `demo_mode`, and no invented prices, times, IDs or statuses.
- Do not copy site data into instructions, and do not paste page state into prompts.
  Agents read state with a read action.
- When unsure whether an action can be undone, make it `irreversible`.
- Keep the site's business rules in the site's own functions. The actions module only
  wraps them.
- Do not edit `runtime/`, `<network>.network.json` or the discovery files by hand.
- Do not put keys, tokens or personal data in any published file.
- Keep the original page usable without the assistant.

## Files in this skill

| Path | Use |
| --- | --- |
| `references/network_design.md` | Inventory, agent count, delegation, instructions, worked example |
| `references/site_actions.md` | Action registry, effects, receipts, what to test |
| `references/bundle_and_hosting.md` | Output layout, manifest, mounting, providers, hosting, discovery |
| `references/live_url_mode.md` | Companion assistant for a public URL without source |
| `runtime/` | Browser runtime; copy into each site unchanged (see `runtime/README.md`) |
| `scripts/build_network.mjs` | HOCON → `.network.json`, with validation and checks |
| `templates/network.hocon` | Network skeleton with shared grounding and CRUSE rules |
| `templates/agent-manifest.json`, `links.json` | Public bundle files |
| `templates/site-actions.js` | Actions module for a site you can change |
| `templates/content-actions.js` | Actions module over a content snapshot (live URL mode) |
| `templates/site.js`, `assistant-section.html`, `assistant.css` | Mounting the assistant in the page |
| `templates/standalone-index.html` | Page for a companion assistant |
| `templates/tests/` | Node tests with a DOM stand-in and a scripted model |
