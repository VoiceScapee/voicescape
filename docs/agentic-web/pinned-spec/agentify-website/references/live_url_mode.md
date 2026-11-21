# Live URL mode

Use this when the input is a public URL and there is no local source for the site.

First ask the user whether they can publish files on that site's own origin.

- **Yes:** get the page source (from the user, or by downloading the public HTML, CSS
  and JavaScript into a working folder), then follow source mode. The assistant must be
  served from the site's own origin to read or change page state.
- **No:** build a **companion assistant**, a separate static site that answers from a
  snapshot of the public pages and sends visitors to the real site to act. This file
  covers the companion assistant.

Only crawl sites the user owns or has permission to use. Respect `robots.txt`.

## What a companion assistant can and cannot do

| Can | Cannot |
| --- | --- |
| Answer from public page content, with links to the source page | See the visitor's cart, login or anything else in their browser session on the real site |
| Call public JSON APIs or GET forms that allow CORS from the assistant's origin | Submit forms that need cookies, CSRF tokens or JavaScript handlers |
| Hand the visitor a deep link to the page where they finish the task | Place orders or bookings on the visitor's behalf, unless the site offers a CORS-enabled API for it |

Tell the user this before building, so they can decide whether a companion is useful.

## Steps

1. **Crawl a small set of pages.** Fetch the home page and the pages its navigation
   links to on the same host, up to about 25 pages. Save the HTML in a scratch folder,
   not in the output. Skip login, account, cart and checkout pages.
2. **Build the snapshot.** Write `site-content.json` in the output folder:

   ```json
   {
     "source": "https://example.com/",
     "fetchedAt": "2026-11-09",
     "pages": [
       {
         "url": "https://example.com/menu",
         "title": "Menu",
         "text": "Plain text of the main content, without navigation and footer."
       }
     ],
     "records": {
       "menu_items": [
         {
           "id": "margherita",
           "name": "Margherita",
           "price": "$12.00",
           "url": "https://example.com/menu#margherita"
         }
       ]
     }
   }
   ```

   Put repeated structured things (products, menu items, rooms, events, opening hours)
   in `records`, with stable `id`s and a source `url`. Keep page text to the main content.
   Never include personal data.
3. **Register read actions** with `templates/content-actions.js`. It offers
   `search_site_content` (keyword search over pages) and `get_site_records` (one
   collection, optionally filtered by id). List both in `actions.agentTools`.
4. **Probe operations.** For each form or API that matters, check CORS from the origin
   where the assistant will be hosted:

   ```shell
   curl -s -D - -o /dev/null -H "Origin: https://assistant.example" "https://example.com/api/availability?date=2026-12-01"
   curl -s -D - -o /dev/null -X OPTIONS -H "Origin: https://assistant.example" \
     -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" \
     "https://example.com/api/orders"
   ```

   Only an `Access-Control-Allow-Origin` header that matches the origin (or `*`) means
   the browser can call it. If it does, register a local-only action that calls `fetch`
   with `credentials: "omit"`. A `GET` that only reads is `read`. Anything that creates
   or changes something is `irreversible`. If CORS is missing, do not register an action:
   the agent links to the page instead.
5. **Write the network.** Usually one agent. In its grounding rules, add:
   - "Answers come from a snapshot of <site> taken on <fetchedAt>. Prices and
     availability may have changed; give the source link."
   - "To <do the operation>, give the visitor the link to <page>. You cannot do it for them."
6. **Make the page.** Start from `templates/standalone-index.html`. It has a short
   intro, a link to the real site, and the assistant section.
7. **Build, test and serve** as in source mode. In the tests, import `ContentActions`
   from the module that `actions.module` names. Right after the import, pass the
   parsed `site-content.json` to `ContentActions.useSnapshot()`, because Node's `fetch`
   cannot read files. Set `READ_ACTION` to `search_site_content` and give each call to
   it a `query`. Delete the write and irreversible tests unless the companion has such
   actions, and check that a search returns a known page.

## Keeping it current

The snapshot does not update by itself. Record the crawl date in `site-content.json` and
in the grounding rules, and re-run steps 1 and 2 to refresh it.
