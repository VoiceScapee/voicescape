// Registers read actions over site-content.json, a snapshot of a public website.
// Use this for a companion assistant that cannot run on the website's own origin.
// List "search_site_content" and "get_site_records" in the manifest's actions.agentTools.

/**
 * Answers questions from a saved snapshot of a public website.
 *
 * The snapshot is a same-origin JSON file, so no CORS is needed. Results carry the
 * source URL and crawl date, so the agent can cite them and warn that they may be stale.
 */
export class ContentActions {
  /**
   * Register the search and records actions.
   *
   * :param actions: The runtime registry facade with a register(definition) method.
   * :return: A promise that resolves when both actions are registered.
   */
  static async registerActions(actions) {
    const snapshot = await ContentActions.load();
    actions.register(ContentActions.searchAction());
    actions.register(ContentActions.recordsAction(Object.keys(snapshot.records || {})));
  }

  /**
   * Use a snapshot already in memory, for tests under Node, which cannot fetch file URLs.
   *
   * :param snapshot: The parsed site-content.json.
   */
  static useSnapshot(snapshot) {
    ContentActions.snapshot = Promise.resolve(snapshot);
  }

  /**
   * Load the snapshot once and reuse it.
   *
   * :return: A promise for the parsed site-content.json.
   */
  static load() {
    if (!ContentActions.snapshot) {
      ContentActions.snapshot = ContentActions.fetchSnapshot();
    }
    return ContentActions.snapshot;
  }

  /**
   * Fetch site-content.json from beside this module.
   *
   * :return: The parsed snapshot.
   * :raises Error: When the file cannot be loaded.
   */
  static async fetchSnapshot() {
    const response = await fetch(new URL("./site-content.json", import.meta.url), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`site-content.json is unavailable: HTTP ${response.status}.`);
    }
    return response.json();
  }

  /**
   * Describe the keyword search action.
   *
   * :return: The action definition.
   */
  static searchAction() {
    return {
      name: "search_site_content",
      description: "Search the saved snapshot of the website's public pages. Returns the best matching pages with title, URL and a text excerpt, plus the snapshot date.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Words to search for, from the visitor's question.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "How many pages to return. Leave out for 5.",
          },
        },
      },
      execute: ContentActions.search,
    };
  }

  /**
   * Describe the structured records action.
   *
   * :param collections: The record collection names in the snapshot.
   * :return: The action definition.
   */
  static recordsAction(collections) {
    return {
      name: "get_site_records",
      description: "Read structured records from the website snapshot, such as products or opening hours. Give a collection, and optionally one record id.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["collection"],
        properties: {
          collection: {
            type: "string",
            enum: collections.length ? collections : ["none"],
            description: "Which collection of records to read.",
          },
          id: {
            type: "string",
            maxLength: 200,
            description: "One record id from an earlier result. Leave out for the whole collection, up to 50 records.",
          },
        },
      },
      execute: ContentActions.records,
    };
  }

  /**
   * Score every page against the query words and return the best matches.
   *
   * :param args: The validated arguments with query and optional limit.
   * :return: The snapshot source, date and matching pages.
   */
  static async search(args) {
    const snapshot = await ContentActions.load();
    const words = ContentActions.words(args.query);
    const matches = [];
    for (const page of snapshot.pages || []) {
      const score = ContentActions.score(page, words);
      if (score > 0) {
        matches.push({
          url: page.url,
          title: page.title,
          score: score,
          excerpt: ContentActions.excerpt(page.text || "", words),
        });
      }
    }
    matches.sort(ContentActions.byScore);
    return {
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      results: matches.slice(0, args.limit || 5),
    };
  }

  /**
   * Return one collection's records, or one record by id.
   *
   * :param args: The validated arguments with collection and optional id.
   * :return: The snapshot source, date and records.
   */
  static async records(args) {
    const snapshot = await ContentActions.load();
    const all = (snapshot.records || {})[args.collection] || [];
    const selected = [];
    for (const record of all) {
      if (args.id === undefined || record.id === args.id) {
        selected.push(record);
      }
    }
    // Tool results are limited to 64 KB, so cap large collections.
    return {
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      collection: args.collection,
      truncated: selected.length > 50,
      records: selected.slice(0, 50),
    };
  }

  /**
   * Split a query into lowercase words of two or more characters.
   *
   * :param query: The search text.
   * :return: The words.
   */
  static words(query) {
    const words = [];
    for (const word of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 1) {
        words.push(word);
      }
    }
    return words;
  }

  /**
   * Count query words in a page, weighting the title higher than the text.
   *
   * :param page: A snapshot page with title and text.
   * :param words: The query words.
   * :return: The score; 0 means no match.
   */
  static score(page, words) {
    const title = String(page.title || "").toLowerCase();
    const text = String(page.text || "").toLowerCase();
    let score = 0;
    for (const word of words) {
      score += 3 * title.split(word).length - 3;
      score += text.split(word).length - 1;
    }
    return score;
  }

  /**
   * Return about 500 characters of text around the first query word found.
   *
   * :param text: The page text.
   * :param words: The query words.
   * :return: The excerpt.
   */
  static excerpt(text, words) {
    const lower = text.toLowerCase();
    let start = 0;
    for (const word of words) {
      const index = lower.indexOf(word);
      if (index >= 0) {
        start = Math.max(0, index - 150);
        break;
      }
    }
    return text.slice(start, start + 500);
  }

  /**
   * Sort matches by score, highest first.
   *
   * :param left: One match.
   * :param right: Another match.
   * :return: A negative number when left should come first.
   */
  static byScore(left, right) {
    return right.score - left.score;
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = ContentActions.registerActions;
