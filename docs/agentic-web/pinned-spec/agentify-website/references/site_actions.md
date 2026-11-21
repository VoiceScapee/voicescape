# Site actions

Site actions connect the agent to what the page can do. The site owns them: the model
can only call an action that the site registered, with arguments that pass its schema.

Each action listed in `agent-manifest.json` → `actions.agentTools` becomes a model tool
named `website_<name>` (`runtime/runner.js`).

## Prepare the site code first

1. **Export shared functions.** The assistant must call the same functions as the
   page's own buttons and forms, so both follow one set of rules. Refactor the page
   script to create one page object at startup and export it, for example as a static
   `App.page`, as `templates/site-actions.js` and `templates/site.js` expect. Do not
   create a second one: it would have its own, separate state. Give the page object:
   - a state reader that returns plain JSON (catalog, current selection, a version
     number, and what each panel shows, such as the latest result), and copies rather
     than live objects. It leaves out other people's records;
   - one method per operation that validates its input, changes state, re-renders
     the page, and returns the new state or a receipt. Make the button handlers call it.
     Keep focus moves and form resets in the handlers, not in the operation: the
     assistant calls the operation while the visitor may be typing in the chat or in the
     page's own form, and a reset would erase what they typed.
2. **Refuse by returning, not by throwing.** Check the whole input before changing
   anything. When the input is refused, return `{"ok": false, "reason": "...", "field": "..."}`
   and change nothing. The runtime reports any thrown error as outcome `unknown` ("may have
   happened, do not retry"), so throw only on unexpected failures. The page's own form
   handler can use `field` and `reason` with `setCustomValidity` to show the same message.
   If the site's own functions already refuse in another shape, such as
   `{errors: {field: message}}`, keep that shape and convert their result in the page
   script's operation function. Join the messages into `reason` and name the first
   field in `field`. Also return the messages by field, so the form still shows each one.
3. **Give each irreversible operation one read-only check.** Put the whole check,
   including the visitor's details, in one function that changes nothing and that the
   operation calls first. If the site's function checks and writes in one step, move its
   checks into such a function in the same module. The confirmation dialog opens before
   the operation runs (`runtime/actions.js`, `execute`), so `site.js` calls the same check
   and opens no dialog when it refuses.
4. **Add a version counter** for state that an irreversible action depends on but does
   not take as arguments, such as a cart. Increment it on every change. The irreversible
   action takes `expectedVersion` and refuses a mismatch, so a visitor never confirms one
   cart and pays for another. An action that takes everything it acts on as arguments
   needs no counter: the dialog shows those arguments. If what the visitor agrees to can
   change without a page change, such as a fee that depends on today's date, also pass
   the value they saw, such as `expectedFee`, and refuse a mismatch. If the site already
   has such a check, use it.
5. **Load the page script as a module** (`<script type="module">`) so it can export.
   Module scripts are deferred, like the `defer` scripts they usually replace.
6. **Import it by the same URL.** The actions module must import the page script by the
   URL the page loads it from, without a `?v=` cache-busting query. A different URL makes
   a second copy of the module with its own, separate state.
7. **Expose page-only facts through the read action.** Facts that exist only in the HTML
   (sizes, fees, opening hours, policies) must not be copied into instructions. Either
   read them from the page's own elements in the state reader (for example
   `document.querySelector("#delivery-note").textContent`, adding ids where needed), or
   move them into one object that both renders the HTML and feeds the state reader.
   For facts on another page of the site, add a read action that fetches that page,
   parses it with `DOMParser` and returns its text. Node has no `DOMParser`, so check
   that action in a browser (see "Check without a key" in `bundle_and_hosting.md`).
8. **Return dates and amounts the model can use.** The model has no clock. If the site
   uses dates, put today's date in the state. Give each date with its weekday, such as
   "Tue, Nov 10, 2026", so the model does not have to work it out. Give amounts as the
   page shows them, such as "$145.00", not raw cents. When a later call must pass an
   amount back, such as an expected fee, also return it in the form that call takes,
   such as `feeCents`.

## Register actions

The module named in `actions.module` exports `registerActions(actions)` and calls
`actions.register(definition)` once per action. Start from `templates/site-actions.js`.

| Field | Rules (from `runtime/actions.js`) |
| --- | --- |
| `name` | Starts with a letter; letters, digits, `_` or `-`; up to 80 characters; unique. |
| `description` | What it does, what it returns, and what it does not do. The model reads this. The confirmation dialog shows the visitor the words from `DIALOGS` in `site.js` instead. |
| `inputSchema` | An object schema. Allowed keywords: `type`, `properties`, `required`, `additionalProperties` (only `false`), `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `format` (`date` or `email`), `title`, `description`, `default`, `x-*`. Anything else fails registration. Depth up to 8. |
| `effect` | `read`, `write` or `irreversible`. See below. |
| `availability` | Leave it out (`local-only`). Only local-only actions become `website_*` tools. |
| `timeoutMs` | Default 180000. A timeout is reported as outcome `unknown`. |
| `execute(args, context)` | Returns JSON data (up to 64 KB), or throws. Never return `undefined`. |

Schema tips:

- Use `enum` for IDs, built from the real catalog, so the model cannot invent items.
- Mark only truly required fields as `required`. Bound numbers and string lengths.
- Let the site's function check values only the visitor can give, such as an email
  or a guest count, so the visitor gets the site's own message. For these, leave out
  `format: "email"` and keep any bound looser than the site's own limit. If the only
  limit is in the HTML, such as `maxlength`, use the same bound: the site's function
  does not check it.
- Give every argument a `description`: what it is and where its value comes from, such
  as the visitor or another tool's result. Keep it short: every model call sends it.
- Extra keys are always rejected, so the schema must list every argument.
- `pattern` is not supported. Check formats such as `HH:MM` in the site function and
  return a refusal; say the expected format in the field's `description`.

## Choose the effect carefully

In the patched runtime, `read` and `write` tools run **immediately, with no dialog**.
Only `irreversible` opens the confirmation dialog first. The spec asks the runtime to
show the visitor a write before it runs (section 3.1), so tell the user about this gap.

| Effect | Use for | Example |
| --- | --- | --- |
| `read` | Returns data, changes nothing. | get menu and cart |
| `write` | Changes page state the visitor can see and undo on the page. | add to cart, set quantities, fill a draft |
| `irreversible` | Anything the visitor cannot undo on the page: it places, sends, books, pays, deletes or contacts someone. | place order, submit request, send message |

A `read` can take arguments. To answer a question that needs details, such as a price or
availability check, add a `read` that calls the site's own function and changes nothing
on the page. An action that only replaces a results panel is still a `write`. Tell the
agent to call a `write` only when the visitor asks for a change, so answering a question
never replaces what the visitor entered.

When in doubt, choose `irreversible`. An irreversible tool is only offered when the
host provides a confirmation callback; `boot()` does this through `engine.onActionConfirm`.
`templates/site.js` replaces that callback with its own dialog, written for the visitor:
a question, one plain sentence, readable details such as items and total, the exact call
under "Technical details", and buttons named after what they do.

## What the model sees

When the arguments pass the schema, the tool result is a receipt:

- `{"status": "succeeded", "result": ...}`: `execute` returned. `result` is what it
  returned: the updated state or receipt, or `{"ok": false, "reason": ...}` for a refusal.
- `{"status": "cancelled"}`: the visitor declined the dialog. Nothing ran.
- `{"status": "unknown", "error": ...}`: `execute` threw, timed out or returned bad data.
  The operation may have happened. The agent must not retry it.

When the arguments fail the schema, nothing runs and the model gets a plain string such
as `Error from tool 'website_add_item': Invalid arguments.id.` The same happens, with the
site's reason, when `site.js` finds that the site would refuse an irreversible call. The
template's `{grounding_rules}` explain all of these cases to the agent.

Tool calls run one at a time, in order. The model writes every call in a reply before
the first one runs, so a call cannot use a result from the same reply.

## What not to expose

- Passwords, login, payment card fields, file uploads. Keep these in the site's own UI.
- Other people's records, such as bookings, orders or accounts. Return one only after
  the page's own check passes, such as a matching code and last name.
- Anything that needs a server the static site does not have. Say "not available"
  instead of faking it.
- Operations on another tab or window: actions run in the visitor's current page.

## Forms the runtime discovers by itself

The runtime can also discover native HTML forms (`actions.pages`, `actions.hostPage`) or
load a reviewed HTTP catalog (`actions.catalog`). Those actions get generated names or
`bridge`/`top-level` availability, so they **do not** become `website_*` tools. The agent
can only offer them as buttons or forms the visitor submits. Prefer explicit
`registerActions` entries that wrap the form's submit function, or that `fetch` its endpoint.

## Test every action

Copy `templates/tests/` into the output site and fill in the TODOs. Before each call
under test, make every panel and field the call could change show something else, such
as earlier search results, another draft or another booking. After the call, compare the
whole page and the stored records, so a change the call should not make shows up. At
minimum, test:

- every `agentTools` name is registered and `local-only`;
- the read tool runs through `runAgent` with a scripted model and returns `succeeded`;
- each `read` that takes arguments leaves the page as it was;
- each write changes state and the visible page, and rejects bad IDs without changing state;
- each call moves no focus: the page's handlers move focus, the operations do not;
- each total or fee an action returns, against an amount worked out by hand from the
  site's prices. Use inputs that hit every pricing rule (such as a weekend night or a
  per-guest extra) and both sides of each boundary (such as the nights just before and
  after the weekend, or the first and last day of each fee tier);
- a value exactly at each limit the site allows is accepted, such as check-in today, the
  longest stay, the longest note or the fewest digits in a phone number;
- each filter a read applies is used, such as a guest count that some rooms do not fit;
- each irreversible tool is hidden without a confirmation callback, and a decline from a
  state where it would succeed changes nothing. If the state reader leaves out the
  record the action changes, also read that record back, such as with a look-up action;
- each approved irreversible call stores the same record as the page's own form, given
  the same input. Fill every field, optional ones too, put spaces around a name, and
  list multiple choices, such as extras, in another order than the form shows them.
  Compare every field of that record, not just the receipt. If the first call uses up
  what the second needs, such as a room or a booking, undo it through the page between
  the two calls, or use two records that are alike;
- each irreversible action's dialog, through `AssistantMount` in `site.js`: its words
  are filled in, each detail matches the call's arguments and an amount worked out by
  hand, and only its confirm button confirms. Give it the same kind of input as the
  approved call: every field, optional ones too, with spaces around the values, and
  choices in another order than the form shows them. For a call the site would refuse,
  `refusal` is the site's reason and `AssistantMount.review` rejects with it, so no
  dialog opens. Check one refusal for each group of rules the check covers, such as a
  taken room and a bad email;
- a stale `expectedVersion` and each other refusal return `ok: false` from the operation
  itself and change nothing;
- no read result, refusal or dialog contains another person's record. Scan them for
  every string value of those records, such as names and codes, not only the IDs, and
  check that a look-up refuses near misses, such as a prefix of the last name. Seeded
  records often have no email or notes, so also make a record in the test with an
  email, a phone number and free-text notes, and check that no result the model gets
  contains them unless the page shows them too.

The DOM stand-ins have no page text and no `after()` or `matches()`. They find elements
by id, by tag name inside an element, and by `<tag>:checked`. Any other selector throws
unless the test gives its matches with `provide(selector, elements)`, and `form.reset()`
throws until the test fills `form.elements`, so nothing the stand-ins cannot do passes
silently. This applies to code the page runs when it loads or renders too. Keep
references to elements the page needs again, or give the test the matches. Check in a
browser what the stand-ins cannot show: the page facts in the read action's result and a
read that needs `DOMParser` (see "Check without a key" in `bundle_and_hosting.md`). Check
the content, not only the count: for example, that a policies result has each fee row,
and that each link in the page facts has its `href`. Also submit each page form with a
value the site refuses, and check the form's own error message.
